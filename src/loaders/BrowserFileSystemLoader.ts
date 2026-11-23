import { E_ROSETTA_UNSUPPORTED_RUNTIME } from "../errors.js";
import type { MessageCatalog, MessageTree, RosettaLoader } from "../Rosetta.js";

export interface FileSystemLoaderOptions {
	location?: string | URL;
	rootDir?: string | URL;
	formats?: Array<"json" | "yaml" | "yml">;
}

export type FsLoaderOptions = FileSystemLoaderOptions;

/** Browser-safe API placeholder used by the conditional browser export. */
export class FileSystemLoader implements RosettaLoader {
	constructor(_options: FileSystemLoaderOptions) {
		throw new E_ROSETTA_UNSUPPORTED_RUNTIME();
	}

	async load(_locale: string): Promise<MessageTree | MessageCatalog | null> {
		throw new E_ROSETTA_UNSUPPORTED_RUNTIME();
	}
}
