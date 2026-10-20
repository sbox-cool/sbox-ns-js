export declare function parseClientType(raw: string | null | undefined): string | null;
export declare function isLibraryCaller(headers: Headers, body: unknown): boolean;
export interface LibraryErrorInput {
    status: number;
    code: string;
    message: string;
    requestId: string;
    errorFields?: Record<string, unknown>;
    security?: Record<string, unknown>;
}
export declare function libraryErrorBody(input: LibraryErrorInput): Record<string, unknown>;
