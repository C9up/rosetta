import type { MessageCatalog, MessageTree, RosettaLoader } from "../Rosetta.js";

export interface FileSystemLoaderOptions {
	location?: string | URL;
	rootDir?: string | URL;
	formats?: Array<"json" | "yaml" | "yml">;
}

export type FsLoaderOptions = FileSystemLoaderOptions;

const ERROR_MESSAGE =
	"FileSystemLoader is only available in runtimes that provide the Node.js filesystem APIs";

/** Browser-safe API placeholder used by the conditional browser export. */
export class FileSystemLoader implements RosettaLoader {
	constructor(_options: FileSystemLoaderOptions) {
		throw new Error(ERROR_MESSAGE);
	}

	async load(_locale: string): Promise<MessageTree | MessageCatalog | null> {
		throw new Error(ERROR_MESSAGE);
	}
}
