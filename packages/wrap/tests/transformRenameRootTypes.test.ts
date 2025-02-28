import { addMocksToSchema } from '@graphql-tools/mock';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { RenameRootTypes, wrapSchema } from '@graphql-tools/wrap';
import { graphql } from 'graphql';
import { describe, expect, test } from 'vitest';

describe('RenameRootTypes', () => {
  test('should work', async () => {
    let subschema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        schema {
          query: QueryRoot
          mutation: MutationRoot
        }

        type QueryRoot {
          foo: String!
        }

        type MutationRoot {
          doSomething: DoSomethingPayload!
        }

        type DoSomethingPayload {
          query: QueryRoot!
        }
      `,
    });

    subschema = addMocksToSchema({ schema: subschema });

    const schema = wrapSchema({
      schema: subschema,
      transforms: [
        new RenameRootTypes((name) => (name === 'QueryRoot' ? 'Query' : name)),
      ],
    });

    const result = await graphql({
      schema,
      source: `
        mutation {
          doSomething {
            query {
              foo
            }
          }
        }
      `,
    });

    expect(result).toEqual({
      data: {
        doSomething: {
          query: {
            foo: 'Hello World',
          },
        },
      },
    });
  });
});
