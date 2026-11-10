interface LocaleStorage<T> {
	enterWith(value: T): void;
	getStore(): T | undefined;
	run<R>(value: T, callback: () => R): R;
}

type AsyncLocalStorageConstructor = new <T>() => LocaleStorage<T>;

class BrowserLocaleStorage<T> implements LocaleStorage<T> {
	#value?: T;

	enterWith(value: T): void {
		this.#value = value;
	}

	getStore(): T | undefined {
		return this.#value;
	}

	run<R>(value: T, callback: () => R): R {
		const previous = this.#value;
		this.#value = value;
		try {
			const result = callback();
			if (
				typeof result === "object" &&
				result !== null &&
				typeof Reflect.get(result, "then") === "function"
			) {
				// Restore once the async callback settles. The reaction is
				// registered before the caller's, so it runs first; the caller
				// still gets the callback's own promise back.
				const restore = () => {
					this.#value = previous;
				};
				Promise.resolve(result).then(restore, restore);
				return result;
			}
			this.#value = previous;
			return result;
		} catch (error) {
			this.#value = previous;
			throw error;
		}
	}
}

let Storage: AsyncLocalStorageConstructor = BrowserLocaleStorage;

const isNode =
	typeof globalThis.process !== "undefined" &&
	typeof globalThis.process.versions?.node === "string";

if (isNode) {
	// Keep the specifier non-literal so browser bundlers do not resolve a Node
	// builtin that can never execute in their runtime.
	const specifier = ["node", "async_hooks"].join(":");
	const asyncHooks: unknown = await import(specifier);
	const nodeStorage =
		typeof asyncHooks === "object" && asyncHooks !== null
			? Reflect.get(asyncHooks, "AsyncLocalStorage")
			: undefined;
	if (isStorageConstructor(nodeStorage)) Storage = nodeStorage;
}

function isStorageConstructor(
	value: unknown,
): value is AsyncLocalStorageConstructor {
	return typeof value === "function";
}

export function createLocaleStorage<T>(): LocaleStorage<T> {
	return new Storage<T>();
}
