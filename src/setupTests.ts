import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock DOMMatrix for pdfjs-dist in jsdom
if (typeof globalThis.DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  };
}

// Mock matchMedia for jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd, args) => {
    if (cmd === 'decrypt_secret') return Promise.resolve(args?.cipherText || '');
    if (cmd === 'encrypt_secret') return Promise.resolve(args?.value || '');
    return Promise.resolve();
  }),
}))

// Mock Tauri window
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    hide: vi.fn(() => Promise.resolve()),
    show: vi.fn(() => Promise.resolve()),
    onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  })),
}))

// Mock Tauri Http
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: 'mock content' } }] }),
  })),
}))

// Mock Tauri Store
vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    private data: Record<string, any> = {};
    constructor(_path: string) {}
    async get(key: string) { return this.data[key] || null; }
    async set(key: string, val: any) { this.data[key] = val; }
    async delete(key: string) { delete this.data[key]; }
    async save() {}
  }
  return {
    LazyStore: MockLazyStore,
  };
});
