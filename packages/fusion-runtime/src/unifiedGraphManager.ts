import type {
  TransportContext,
  TransportEntry,
} from '@graphql-mesh/transport-common';
import type { Logger, OnDelegateHook } from '@graphql-mesh/types';
import { getInContextSDK, requestIdByRequest } from '@graphql-mesh/utils';
import type {
  DelegationPlanBuilder,
  StitchingInfo,
  SubschemaConfig,
} from '@graphql-tools/delegate';
import type {
  IResolvers,
  MaybePromise,
  TypeSource,
} from '@graphql-tools/utils';
import {
  createGraphQLError,
  isDocumentNode,
  isPromise,
  mapMaybePromise,
  printSchemaWithDirectives,
} from '@graphql-tools/utils';
import {
  AsyncDisposableStack,
  DisposableSymbols,
} from '@whatwg-node/disposablestack';
import type { DocumentNode, GraphQLError, GraphQLSchema } from 'graphql';
import { buildASTSchema, buildSchema, isSchema, print } from 'graphql';
import { handleFederationSupergraph } from './federation/supergraph';
import {
  compareSchemas,
  compareSubgraphNames,
  getOnSubgraphExecute,
  millisecondsToStr,
  OnDelegationPlanDoneHook,
  OnDelegationPlanHook,
  OnDelegationStageExecuteHook,
  type OnSubgraphExecuteHook,
  type Transports,
} from './utils';

export type TransportEntryAdditions = {
  [subgraph: '*' | string]: Partial<TransportEntry>;
};

export function ensureSchema(source: GraphQLSchema | DocumentNode | string) {
  if (isSchema(source)) {
    return source;
  }
  if (typeof source === 'string') {
    return buildSchema(source, { assumeValid: true, assumeValidSDL: true });
  }
  if (isDocumentNode(source)) {
    return buildASTSchema(source, { assumeValid: true, assumeValidSDL: true });
  }
  return source;
}

export type UnifiedGraphHandler = (
  opts: UnifiedGraphHandlerOpts,
) => UnifiedGraphHandlerResult;

export interface UnifiedGraphHandlerOpts {
  unifiedGraph: GraphQLSchema;
  additionalTypeDefs?: TypeSource;
  additionalResolvers?: IResolvers<unknown, any> | IResolvers<unknown, any>[];
  onSubgraphExecute: ReturnType<typeof getOnSubgraphExecute>;
  onDelegationStageExecuteHooks?: OnDelegationStageExecuteHook<any>[];
  transportEntryAdditions?: TransportEntryAdditions;
  /**
   * Whether to batch the subgraph executions.
   * @default true
   */
  batch?: boolean;

  logger?: Logger;
}

export interface UnifiedGraphHandlerResult {
  unifiedGraph: GraphQLSchema;
  transportEntryMap: Record<string, TransportEntry>;
  subschemas: SubschemaConfig[];
  additionalResolvers: IResolvers[];
}

export interface UnifiedGraphManagerOptions<TContext> {
  getUnifiedGraph(
    ctx: TransportContext,
  ): MaybePromise<GraphQLSchema | string | DocumentNode>;
  // Handle the unified graph by any specification
  handleUnifiedGraph?: UnifiedGraphHandler;
  transports?: Transports;
  transportEntryAdditions?: TransportEntryAdditions;
  /** Schema polling interval in milliseconds. */
  pollingInterval?: number;
  additionalTypeDefs?: TypeSource;
  additionalResolvers?:
    | IResolvers<unknown, TContext>
    | IResolvers<unknown, TContext>[];
  transportContext?: TransportContext;
  onSubgraphExecuteHooks?: OnSubgraphExecuteHook<TContext>[];
  // TODO: Will be removed later once we get rid of v0
  onDelegateHooks?: OnDelegateHook<unknown>[];
  onDelegationPlanHooks?: OnDelegationPlanHook<TContext>[];
  onDelegationStageExecuteHooks?: OnDelegationStageExecuteHook<TContext>[];
  /**
   * Whether to batch the subgraph executions.
   * @default true
   */
  batch?: boolean;
}

const UNIFIEDGRAPH_CACHE_KEY = 'hive-gateway:supergraph';

export class UnifiedGraphManager<TContext> implements AsyncDisposable {
  private batch: boolean;
  private handleUnifiedGraph: UnifiedGraphHandler;
  private unifiedGraph?: GraphQLSchema;
  private lastLoadedUnifiedGraph?: string | GraphQLSchema | DocumentNode;
  private onSubgraphExecuteHooks: OnSubgraphExecuteHook<TContext>[];
  private onDelegationPlanHooks: OnDelegationPlanHook<TContext>[];
  private onDelegationStageExecuteHooks: OnDelegationStageExecuteHook<TContext>[];
  private inContextSDK: any;
  private initialUnifiedGraph$?: MaybePromise<GraphQLSchema>;
  private polling$?: MaybePromise<void>;
  private _transportEntryMap?: Record<string, TransportEntry>;
  private _transportExecutorStack?: AsyncDisposableStack;
  private lastLoadTime?: number;
  constructor(private opts: UnifiedGraphManagerOptions<TContext>) {
    this.batch = opts.batch ?? true;
    this.handleUnifiedGraph =
      opts.handleUnifiedGraph || handleFederationSupergraph;
    this.onSubgraphExecuteHooks = opts?.onSubgraphExecuteHooks || [];
    this.onDelegationPlanHooks = opts?.onDelegationPlanHooks || [];
    this.onDelegationStageExecuteHooks =
      opts?.onDelegationStageExecuteHooks || [];
    if (opts.pollingInterval != null) {
      opts.transportContext?.logger?.debug(
        `Starting polling to Supergraph with interval ${millisecondsToStr(opts.pollingInterval)}`,
      );
    }
  }

  private cleanup() {
    this.unifiedGraph = undefined;
    this.lastLoadedUnifiedGraph = undefined;
    this.inContextSDK = undefined;
    this.initialUnifiedGraph$ = undefined;
    this.lastLoadTime = undefined;
    this.polling$ = undefined;
  }

  private ensureUnifiedGraph(): MaybePromise<GraphQLSchema> {
    if (
      this.polling$ == null &&
      this.opts?.pollingInterval != null &&
      this.lastLoadTime != null &&
      Date.now() - this.lastLoadTime >= this.opts.pollingInterval
    ) {
      this.opts?.transportContext?.logger?.debug(`Polling Supergraph`);
      this.polling$ = mapMaybePromise(this.getAndSetUnifiedGraph(), () => {
        this.polling$ = undefined;
      });
    }
    if (!this.unifiedGraph) {
      if (!this.initialUnifiedGraph$) {
        this.opts?.transportContext?.logger?.debug(
          'Fetching the initial Supergraph',
        );
        if (this.opts.transportContext?.cache) {
          this.opts.transportContext?.logger?.debug(
            `Searching for Supergraph in cache under key "${UNIFIEDGRAPH_CACHE_KEY}"...`,
          );
          this.initialUnifiedGraph$ = mapMaybePromise(
            this.opts.transportContext.cache.get(UNIFIEDGRAPH_CACHE_KEY),
            (cachedUnifiedGraph) => {
              if (cachedUnifiedGraph) {
                this.opts.transportContext?.logger?.debug(
                  'Found Supergraph in cache',
                );
                return this.handleLoadedUnifiedGraph(cachedUnifiedGraph, true);
              }
              return this.getAndSetUnifiedGraph();
            },
            () => {
              return this.getAndSetUnifiedGraph();
            },
          );
        } else {
          this.initialUnifiedGraph$ = this.getAndSetUnifiedGraph();
        }
        this.initialUnifiedGraph$ = mapMaybePromise(
          this.initialUnifiedGraph$,
          (v) => {
            this.initialUnifiedGraph$ = undefined;
            this.opts.transportContext?.logger?.debug(
              'Initial Supergraph fetched',
            );
            return v;
          },
        );
      }
      return this.initialUnifiedGraph$ || this.unifiedGraph;
    }
    return this.unifiedGraph;
  }

  private disposeReason: GraphQLError | undefined;

  private handleLoadedUnifiedGraph(
    loadedUnifiedGraph: string | GraphQLSchema | DocumentNode,
    doNotCache?: boolean,
  ): MaybePromise<GraphQLSchema> {
    if (
      loadedUnifiedGraph != null &&
      this.lastLoadedUnifiedGraph != null &&
      compareSchemas(loadedUnifiedGraph, this.lastLoadedUnifiedGraph)
    ) {
      this.opts.transportContext?.logger?.debug(
        'Supergraph has not been changed, skipping...',
      );
      this.lastLoadTime = Date.now();
      if (!this.unifiedGraph) {
        throw new Error(`This should not happen!`);
      }
      return this.unifiedGraph;
    }
    if (this.lastLoadedUnifiedGraph != null) {
      this.disposeReason = createGraphQLError(
        'operation has been aborted due to a schema reload',
        {
          extensions: {
            code: 'SCHEMA_RELOAD',
            http: {
              status: 503,
            },
          },
        },
      );
      this.opts.transportContext?.logger?.debug(
        'Supergraph has been changed, updating...',
      );
    }
    if (!doNotCache && this.opts.transportContext?.cache) {
      let serializedUnifiedGraph: string | undefined;
      if (typeof loadedUnifiedGraph === 'string') {
        serializedUnifiedGraph = loadedUnifiedGraph;
      } else if (isSchema(loadedUnifiedGraph)) {
        serializedUnifiedGraph = printSchemaWithDirectives(loadedUnifiedGraph);
      } else if (isDocumentNode(loadedUnifiedGraph)) {
        serializedUnifiedGraph = print(loadedUnifiedGraph);
      }
      if (serializedUnifiedGraph != null) {
        try {
          const ttl = this.opts.pollingInterval
            ? this.opts.pollingInterval * 0.001
            : // if no polling interval (cache TTL) is configured, default to
              // 60 seconds making sure the unifiedgraph is not kept forever
              // NOTE: we default to 60s because Cloudflare KV TTL does not accept anything less
              60;
          this.opts.transportContext.logger?.debug(
            `Caching Supergraph with TTL ${ttl}s`,
          );
          const logCacheSetError = (e: unknown) => {
            this.opts.transportContext?.logger?.debug(
              `Unable to store Supergraph in cache under key "${UNIFIEDGRAPH_CACHE_KEY}" with TTL ${ttl}s`,
              e,
            );
          };
          try {
            const cacheSet$ = this.opts.transportContext.cache.set(
              UNIFIEDGRAPH_CACHE_KEY,
              serializedUnifiedGraph,
              { ttl },
            );
            if (isPromise(cacheSet$)) {
              cacheSet$.then(() => {}, logCacheSetError);
              this._transportExecutorStack?.defer(() => cacheSet$);
            }
          } catch (e) {
            logCacheSetError(e);
          }
        } catch (e) {
          this.opts.transportContext.logger?.error(
            'Failed to initiate caching of Supergraph',
            e,
          );
        }
      }
    }
    return mapMaybePromise(
      this._transportExecutorStack?.disposeAsync?.(),
      () => {
        this.disposeReason = undefined;
        this._transportExecutorStack = new AsyncDisposableStack();
        this._transportExecutorStack.defer(() => {
          this.cleanup();
        });
        this.lastLoadedUnifiedGraph = loadedUnifiedGraph;
        this.unifiedGraph = ensureSchema(loadedUnifiedGraph);
        const {
          unifiedGraph: newUnifiedGraph,
          transportEntryMap,
          subschemas,
          additionalResolvers,
        } = this.handleUnifiedGraph({
          unifiedGraph: this.unifiedGraph,
          additionalTypeDefs: this.opts.additionalTypeDefs,
          additionalResolvers: this.opts.additionalResolvers,
          onSubgraphExecute(subgraphName, execReq) {
            return onSubgraphExecute(subgraphName, execReq);
          },
          onDelegationStageExecuteHooks: this.onDelegationStageExecuteHooks,
          transportEntryAdditions: this.opts.transportEntryAdditions,
          batch: this.batch,
          logger: this.opts.transportContext?.logger,
        });
        this.unifiedGraph = newUnifiedGraph;
        const onSubgraphExecute = getOnSubgraphExecute({
          onSubgraphExecuteHooks: this.onSubgraphExecuteHooks,
          transports: this.opts.transports,
          transportContext: this.opts.transportContext,
          transportEntryMap,
          getSubgraphSchema(subgraphName) {
            const subgraph = subschemas.find(
              (s) => s.name && compareSubgraphNames(s.name, subgraphName),
            );
            if (!subgraph) {
              throw new Error(`Subgraph ${subgraphName} not found`);
            }
            return subgraph.schema;
          },
          transportExecutorStack: this._transportExecutorStack,
          getDisposeReason: () => this.disposeReason,
        });
        if (this.opts.additionalResolvers || additionalResolvers.length) {
          this.inContextSDK = getInContextSDK(
            this.unifiedGraph,
            // @ts-expect-error Legacy Mesh RawSource is not compatible with new Mesh
            subschemas,
            this.opts.transportContext?.logger,
            this.opts.onDelegateHooks || [],
          );
        }
        this.lastLoadTime = Date.now();
        this._transportEntryMap = transportEntryMap;
        const stitchingInfo = this.unifiedGraph?.extensions?.[
          'stitchingInfo'
        ] as StitchingInfo;
        if (stitchingInfo && this.onDelegationPlanHooks?.length) {
          for (const typeName in stitchingInfo.mergedTypes) {
            const mergedTypeInfo = stitchingInfo.mergedTypes[typeName];
            if (mergedTypeInfo) {
              const originalDelegationPlanBuilder =
                mergedTypeInfo.nonMemoizedDelegationPlanBuilder;
              mergedTypeInfo.nonMemoizedDelegationPlanBuilder = (
                supergraph,
                sourceSubschema,
                variables,
                fragments,
                fieldNodes,
                context,
                info,
              ) => {
                let delegationPlanBuilder = originalDelegationPlanBuilder;
                function setDelegationPlanBuilder(
                  newDelegationPlanBuilder: DelegationPlanBuilder,
                ) {
                  delegationPlanBuilder = newDelegationPlanBuilder;
                }
                const onDelegationPlanDoneHooks: OnDelegationPlanDoneHook[] =
                  [];
                let logger = this.opts.transportContext?.logger;
                let requestId: string | undefined;
                if (context?.request) {
                  requestId = requestIdByRequest.get(context.request);
                  if (requestId) {
                    logger = logger?.child(requestId);
                  }
                }
                if (sourceSubschema.name) {
                  logger = logger?.child(sourceSubschema.name);
                }
                for (const onDelegationPlan of this.onDelegationPlanHooks) {
                  const onDelegationPlanDone = onDelegationPlan({
                    supergraph,
                    subgraph: sourceSubschema.name!,
                    sourceSubschema,
                    typeName: mergedTypeInfo.typeName,
                    variables,
                    fragments,
                    fieldNodes,
                    logger,
                    context,
                    info,
                    delegationPlanBuilder,
                    setDelegationPlanBuilder,
                  });
                  if (onDelegationPlanDone) {
                    onDelegationPlanDoneHooks.push(onDelegationPlanDone);
                  }
                }
                let delegationPlan = delegationPlanBuilder(
                  supergraph,
                  sourceSubschema,
                  variables,
                  fragments,
                  fieldNodes,
                  context,
                  info,
                );
                function setDelegationPlan(
                  newDelegationPlan: ReturnType<DelegationPlanBuilder>,
                ) {
                  delegationPlan = newDelegationPlan;
                }
                for (const onDelegationPlanDone of onDelegationPlanDoneHooks) {
                  onDelegationPlanDone({
                    delegationPlan,
                    setDelegationPlan,
                  });
                }
                return delegationPlan;
              };
            }
          }
        }
        return this.unifiedGraph;
      },
    );
  }

  private getAndSetUnifiedGraph(): MaybePromise<GraphQLSchema> {
    try {
      return mapMaybePromise(
        this.opts.getUnifiedGraph(this.opts.transportContext || {}),
        (loadedUnifiedGraph: string | GraphQLSchema | DocumentNode) =>
          this.handleLoadedUnifiedGraph(loadedUnifiedGraph),
        (err) => {
          this.opts.transportContext?.logger?.error(
            'Failed to load Supergraph',
            err,
          );
          this.lastLoadTime = Date.now();
          if (!this.unifiedGraph) {
            throw err;
          }
          return this.unifiedGraph;
        },
      );
    } catch (e) {
      this.opts.transportContext?.logger?.error('Failed to load Supergraph', e);
      this.lastLoadTime = Date.now();
      if (!this.unifiedGraph) {
        throw e;
      }
      return this.unifiedGraph;
    }
  }

  public getUnifiedGraph(): MaybePromise<GraphQLSchema> {
    return mapMaybePromise(this.ensureUnifiedGraph(), () => {
      if (!this.unifiedGraph) {
        throw new Error(`This should not happen!`);
      }
      return this.unifiedGraph;
    });
  }

  public getContext<T extends {} = {}>(base: T = {} as T) {
    return mapMaybePromise(this.ensureUnifiedGraph(), () => {
      if (this.inContextSDK) {
        Object.assign(base, this.inContextSDK);
      }
      Object.assign(base, this.opts.transportContext);
      return base;
    });
  }

  public getTransportEntryMap() {
    return mapMaybePromise(this.ensureUnifiedGraph(), () => {
      if (!this._transportEntryMap) {
        throw new Error(`This should not happen!`);
      }
      return this._transportEntryMap;
    });
  }

  invalidateUnifiedGraph() {
    return this.getAndSetUnifiedGraph();
  }

  [DisposableSymbols.asyncDispose]() {
    this.cleanup();
    this.disposeReason = createGraphQLError(
      'operation has been aborted because the server is shutting down',
      {
        extensions: {
          code: 'SHUTTING_DOWN',
        },
      },
    );
    return this._transportExecutorStack?.disposeAsync() as PromiseLike<void>;
  }
}
