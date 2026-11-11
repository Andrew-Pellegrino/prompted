// Deployed entry point: the Worker plus the built site packaged alongside it (see assets.mjs).
// Run `npm run build` first; it writes .generated/embedded-assets.mjs.
import worker from './index.mjs';
import { embeddedAssets } from './assets.mjs';
import { FILES } from '../../.generated/embedded-assets.mjs';

const ASSETS = embeddedAssets(FILES);
const withAssets = (env) => (env.ASSETS ? env : { ...env, ASSETS });
export default {
  fetch: (request, env, ctx) => worker.fetch(request, withAssets(env), ctx),
  scheduled: (event, env, ctx) => worker.scheduled(event, withAssets(env), ctx),
};
