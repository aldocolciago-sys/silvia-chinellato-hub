import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
        environment: 'node',
        testTimeout: 15000,
        restoreMocks: true,
        env: { TZ: 'Europe/Rome' },
        coverage: {
            provider: 'v8',
            include: ['api/**/*.js'],
            reporter: ['text', 'html', 'lcov'],
            reportsDirectory: 'coverage',
            thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 }
        }
    }
});
