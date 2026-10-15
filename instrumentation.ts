// Runs once per server process before any request is handled (Next.js instrumentation hook).
// Installs the one limiter for every server-side Alchemy call: app/lib/alchemyLimiter.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installAlchemyLimiter } = await import('./app/lib/alchemyLimiter');
    installAlchemyLimiter();
  }
}
