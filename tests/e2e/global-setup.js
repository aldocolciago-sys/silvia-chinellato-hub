import { buildTailwind } from '../support/build-tailwind.mjs';

/** Prima degli E2E: genera il CSS Tailwind che sostituisce il Play CDN. */
export default async function globalSetup() {
    await buildTailwind();
}
