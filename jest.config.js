/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testPathIgnorePatterns: ['<rootDir>/dist/'],
  globalTeardown: '<rootDir>/tests/globalTeardown.js',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/agents/search.ts',
    '!src/agents/shopping.ts',
    '!src/agents/workspace/calendar.ts',
    '!src/agents/workspace/gmail.ts',
    '!src/agents/workspace/sheets.ts',
    '!src/agents/workspace/docs.ts',
    '!src/transport/whatsapp.ts',
    '!src/index.ts'
  ],
};

