import { Plugin } from './plugin'
import { OperationObject, isOfKind, delegate } from '../operations'

const namespace = '@cuillere/channels'

export function channelsPlugin(): Plugin<ChannelsContext> {
  return {
    namespace,

    handlers: {
      * '@cuillere/core/start'(operation, ctx) {
        ctx[CHANS] = new WeakMap()
        yield delegate(operation)
      },

      * chan({ bufferSize }: Chan, ctx) {
        const key = chanKey(bufferSize)

        ctx[CHANS].set(key, {
          buffer: Array(bufferSize),
          bufferSize: 0,
          sendQ: new ChanQ(),
          recvQ: new ChanQ(),
          closed: false,
        })

        return key
      },

      * close({ chanKey }: ChanOperation, ctx) {
        const ch = ctx[CHANS].get(chanKey)

        if (ch.closed) throw TypeError(`close on closed ${chanKey}`)

        ch.closed = true

        let recver: Recver
        while (recver = ch.recvQ.shift()) recver([undefined, false])
      },

      * range({ chanKey }: ChanOperation, ctx) {
        return {
          async next() {
            const [value, ok] = await doRecv(ctx, chanKey)
            return {
              value,
              done: !ok,
            }
          },

          [Symbol.asyncIterator]() {
            return this
          },
        }
      },

      async* recv({ chanKey, detail }: Recv, ctx) {
        const res = await doRecv(ctx, chanKey)
        return detail ? res : res[0]
      },

      async* select({ cases }: Select, ctx) {
        const indexes = new Map(cases.map((caze, i) => [caze, i]))

        const readyCases = cases.filter((caze) => {
          if (isDefault(caze)) return false
          if (isSend(caze)) return isSendReady(ctx, caze)
          if (isRecv(caze)) return isRecvReady(ctx, caze)
          throw new TypeError('unknown case type')
        }) as (Send | Recv)[]

        if (readyCases.length !== 0) {
          const caze = readyCases[
            readyCases.length === 1 ? 0 : Math.floor(Math.random() * readyCases.length)
          ]
          const index = indexes.get(caze)
          if (isSend(caze)) {
            syncSend(ctx, caze.chanKey, caze.value)
            return [index]
          }
          if (isRecv(caze)) {
            const res = syncRecv(ctx, caze.chanKey)
            return [index, caze.detail ? res : res[0]]
          }
        }

        if (indexes.has(DEFAULT)) return [indexes.get(DEFAULT)]

        const casesByChanKey = new Map<ChanKey, [Send[], Recv[]]>()
        cases.forEach((caze) => {
          if (isDefault(caze)) return
          if (casesByChanKey.has(caze.chanKey)) {
            if (isSend(caze)) casesByChanKey.get(caze.chanKey)[0].push(caze)
            if (isRecv(caze)) casesByChanKey.get(caze.chanKey)[1].push(caze)
          } else {
            if (isSend(caze)) casesByChanKey.set(caze.chanKey, [[caze], []])
            if (isRecv(caze)) casesByChanKey.set(caze.chanKey, [[], [caze]])
          }
        })

        const [caze, res] = await new Promise<[Send] | [Recv, [any, boolean]]>((resolve) => {
          const resolvers: (Sender | Recver)[] = []
          const cancel = () => resolvers.forEach((resolver) => {
            resolver.cancelled = true // eslint-disable-line no-param-reassign
          })

          for (const [chanKey, [sends, recvs]] of casesByChanKey.entries()) {
            const ch = ctx[CHANS].get(chanKey)

            if (sends.length !== 0) {
              const sender: Sender = () => {
                cancel()
                const send = sends.length === 1 ? sends[0] : (
                  sends[Math.floor(Math.random() * sends.length)]
                )
                resolve([send])
                return send.value
              }
              ch.sendQ.push(sender)
              resolvers.push(sender)
            }

            if (recvs.length !== 0) {
              const rcver: Recver = (res) => {
                cancel()
                const recv = recvs.length === 1 ? recvs[0] : (
                  recvs[Math.floor(Math.random() * recvs.length)]
                )
                resolve([recv, res])
              }
              ch.recvQ.push(rcver)
              resolvers.push(rcver)
            }
          }
        })

        const index = indexes.get(caze)
        if (isSend(caze)) return [index]
        if (isRecv(caze)) return [index, caze.detail ? res : res[0]]
        throw new TypeError('unknown case type')
      },

      async* send({ chanKey, value }: Send, ctx) {
        if (syncSend(ctx, chanKey, value)) return

        await new Promise<void>(resolve => ctx[CHANS].get(chanKey).sendQ.push(() => {
          resolve()
          return value
        }))
      },
    },
  }
}

interface ChannelsContext {
  [CHANS]: WeakMap<ChanKey, ChanState>
}

const CHANS = Symbol('CHANS')

export type ChanKey = object // eslint-disable-line @typescript-eslint/ban-types

interface ChanState {
  buffer: any[]
  bufferSize: number
  sendQ: ChanQ<Sender>
  recvQ: ChanQ<Recver>
  closed: boolean
}

class ChanQ<T extends Cancellable> {
  private q: T[] = []

  public push(r: T) {
    this.q.push(r)
  }

  public shift(): T {
    let r: T
    while (r = this.q.shift()) {
      if (!r.cancelled) return r
    }
    return undefined
  }

  public length() {
    return this.q.filter(r => !r.cancelled).length
  }
}

interface Cancellable {
  cancelled?: true
}

interface Sender extends Cancellable {
  (): any
}

interface Recver extends Cancellable {
  ([any, boolean]): void
}

export interface ChanOperation extends OperationObject {
  chanKey: ChanKey
}

export interface Chan extends OperationObject {
  bufferSize: number
}

export const chan = (bufferSize = 0): Chan => ({ kind: `${namespace}/chan`, bufferSize })

let nextChanId = 1

const chanKey = (bufferSize: number): ChanKey => new String(`chan #${nextChanId++} { bufferSize: ${bufferSize} }`)

export const close = (chanKey: ChanKey): ChanOperation => ({ kind: `${namespace}/close`, chanKey })

export const range = (chanKey: ChanKey): ChanOperation => ({ kind: `${namespace}/range`, chanKey })

export interface Recv extends ChanOperation {
  detail: boolean
}

export const recv = (chanKey: ChanKey, detail = false): Recv => ({ kind: `${namespace}/recv`, chanKey, detail })

const isRecv = isOfKind<Recv>(`${namespace}/recv`)

const isRecvReady = (ctx: ChannelsContext, { chanKey }: Recv): boolean => {
  const ch = ctx[CHANS].get(chanKey)
  return ch.bufferSize !== 0 || ch.sendQ.length() !== 0 || ch.closed
}

const syncRecv = (ctx: ChannelsContext, chanKey: ChanKey): [any, boolean] => {
  const ch = ctx[CHANS].get(chanKey)

  if (ch.bufferSize !== 0) {
    const value = ch.buffer[0]
    ch.buffer.copyWithin(0, 1)

    const sender = ch.sendQ.shift()
    if (sender) ch.buffer[ch.bufferSize - 1] = sender()
    else ch.bufferSize--

    return [value, true]
  }

  const sender = ch.sendQ.shift()
  if (sender) return [sender(), true]

  if (ch.closed) return [undefined, false]

  return undefined
}

const doRecv = async (ctx: ChannelsContext, chanKey: ChanKey) => {
  const res = syncRecv(ctx, chanKey)
  if (res) return res

  return new Promise<[any, boolean]>(resolve => ctx[CHANS].get(chanKey).recvQ.push(resolve))
}

const DEFAULT = Symbol('DEFAULT')

export type Case = Send | Recv | typeof DEFAULT

const isDefault = (caze: Case): caze is typeof DEFAULT => caze === DEFAULT

export interface Select extends OperationObject {
  cases: Case[]
}

export const select = (...cases: Case[]): Select => ({ kind: `${namespace}/select`, cases })
select.default = DEFAULT

export interface Send extends ChanOperation {
  value: any
}

export const send = (chanKey: ChanKey, value: any): Send => ({ kind: `${namespace}/send`, chanKey, value })

const isSend = isOfKind<Send>(`${namespace}/send`)

const isSendReady = (ctx: ChannelsContext, { chanKey }: Send): boolean => {
  const ch = ctx[CHANS].get(chanKey)
  if (ch.closed) throw TypeError(`send on closed ${chanKey}`)
  return ch.recvQ.length() !== 0 || ch.bufferSize !== ch.buffer.length
}

const syncSend = (ctx: ChannelsContext, chanKey: ChanKey, value: any): boolean => {
  const ch = ctx[CHANS].get(chanKey)

  if (ch.closed) throw TypeError(`send on closed ${chanKey}`)

  const recver = ch.recvQ.shift()
  if (recver) {
    recver([value, true])
    return true
  }

  if (ch.bufferSize !== ch.buffer.length) {
    ch.buffer[ch.bufferSize++] = value
    return true
  }

  return false
}
