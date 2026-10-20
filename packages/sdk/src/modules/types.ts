/**
 * One catalog record in the editor's authoring format: an endpoint, collection, query, or game-value item.
 * Modules use the same records as the server catalog, so `compileBatch` validates them exactly as
 * `PUT /v1/manage/{project}/sync` would.
 */
export type ModuleRecord = Readonly<Record<string, unknown>>;

/**
 * A portable module: catalog records under a namespace. Every id (endpoint, collection, query, game-value item)
 * MUST start with `${id}_`, so a module can never overwrite a project's own resources outside its namespace.
 */
export interface SboxModule {
  /** Lowercase letters, digits, underscores, and hyphens. Also the namespace prefix. */
  readonly id: string;
  /** Semantic version `major.minor.patch`. A project that already has this or a newer version is left unchanged. */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly collections: readonly ModuleRecord[];
  readonly gameValues: readonly ModuleRecord[];
  readonly endpoints: readonly ModuleRecord[];
  readonly queries: readonly ModuleRecord[];
}
