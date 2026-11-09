import { assertTailwindUpToDate } from '../support/build-tailwind.mjs';

/** Prima degli E2E: il CSS compilato deve corrispondere alle classi usate nelle pagine. */
export default async function globalSetup() {
    await assertTailwindUpToDate();
}
