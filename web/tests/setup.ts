const values = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', { value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
