import { gql } from 'apollo-server-koa'

export const typeDefs = gql`
  type Query {
    hello(name: String): String!
    all: [String!]!
  }

  type Mutation {
    setupDatabase: Boolean
    addName(name: String!): String!
    setName(before: String!, after: String!): String
    wait: String
  }
`
