import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores:['dist','coverage','eslint.config.js','scripts/**/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files:['**/*.{ts,tsx}'],
    languageOptions:{ globals:{...globals.browser,...globals.es2022}, parserOptions:{projectService:true,tsconfigRootDir:import.meta.dirname} },
    plugins:{'jsx-a11y':jsxA11y,'react-hooks':reactHooks},
    rules:{...jsxA11y.flatConfigs.recommended.rules,...reactHooks.configs.recommended.rules},
  },
  { files:['vite.config.ts','vitest.config.ts'], languageOptions:{globals:{...globals.node}} },
);
