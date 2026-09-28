import { defineConfig } from 'vitest/config';

// Test delle regole Firestore: richiedono l'emulatore (npm run test:rules lo avvia da solo).
export default defineConfig({
    test: {
        include: ['tests/rules/**/*.test.js'],
        environment: 'node',
        testTimeout: 20000,
        fileParallelism: false
    }
});
