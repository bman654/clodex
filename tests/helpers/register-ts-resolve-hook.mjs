// tests/helpers/register-ts-resolve-hook.mjs — `node --import` entry for the hook.
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);
