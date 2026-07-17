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
				"finally" in result &&
				typeof result.finally === "function"
			) {
				return result.finally(() => {
					this.#value = previous;
				}) as R;
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
	const asyncHooks = (await import(specifier)) as {
		AsyncLocalStorage: AsyncLocalStorageConstructor;
	};
	Storage = asyncHooks.AsyncLocalStorage;
}

export function createLocaleStorage<T>(): LocaleStorage<T> {
	return new Storage<T>();
}
