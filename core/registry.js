export const registry = {
  modules: new Map(),
  register(mod) {
    if (!mod?.id) throw new Error('module needs id');
    this.modules.set(mod.id, {
      enabled: false, order: 100,
      onRequest: null, onResponse: null, tags: null,
      ...mod,
    });
  },
  get(id) { return this.modules.get(id); },
  list() { return [...this.modules.values()].sort((a, b) => a.order - b.order); },
  enabled() { return this.list().filter(m => m.enabled); },
};