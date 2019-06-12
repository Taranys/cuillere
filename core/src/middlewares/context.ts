import { Middleware } from './index'

const CONTEXT_SYMBOL = Symbol('CONTEXT')
const GET_SYMBOL = Symbol('GET')
const SET_SYMBOL = Symbol('SET')

interface ContextOperation {
  [CONTEXT_SYMBOL]: true
}

interface Set extends ContextOperation {
  [SET_SYMBOL]: true
  key: string
  value: any
}

interface Get extends ContextOperation {
  [GET_SYMBOL]: true
  key: string
}

export const get = (key: string): Get => ({
  [CONTEXT_SYMBOL]: true,
  [GET_SYMBOL]: true,
  key,
})

export const set = (key: string, value: any): Set => ({
  [CONTEXT_SYMBOL]: true,
  [SET_SYMBOL]: true,
  key,
  value,
})

const isContextOperation = (operation: any): operation is ContextOperation =>
  operation && operation[CONTEXT_SYMBOL]

const isSet = (operation: ContextOperation): operation is Set => operation && operation[SET_SYMBOL]

const isGet = (operation: ContextOperation): operation is Get => operation && operation[GET_SYMBOL]

export const contextMiddleware: Middleware = next => (operation, ctx) => {
  if (!isContextOperation(operation)) return next(operation)

  if (isGet(operation)) return ctx[operation.key]
  if (isSet(operation)) ctx[operation.key] = operation.value
}
