const here = new URL('./', import.meta.url);
const src = new URL('../../../src/', import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec === '@capacitor-community/sqlite') return { url: new URL('sqlite.mjs', here).href, shortCircuit: true };
  if (/(^|\/)platform\.js$/.test(spec) && ctx.parentURL?.startsWith(src)) return { url: new URL('platform.mjs', here).href, shortCircuit: true };
  if (spec.startsWith('@capacitor/') || spec.startsWith('@capacitor-firebase/') || spec.startsWith('capacitor-')) {
    return { url: new URL('capacitor.mjs', here).href, shortCircuit: true };
  }
  return next(spec, ctx);
}
// Vite's import.meta.env does not exist in Node.
export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.startsWith(src) && r.source) {
    const code = String(r.source).replaceAll('import.meta.env', '({DEV:false,PROD:true,MODE:"production"})');
    return { ...r, source: code, format: r.format || 'module' };
  }
  return r;
}
