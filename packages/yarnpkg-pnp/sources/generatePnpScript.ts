import {generatePrettyJson}      from './generatePrettyJson';
import {generateSerializedState} from './generateSerializedState';
// @ts-expect-error
import getTemplate               from './hook';
import {SerializedState}         from './types';
import {PnpSettings}             from './types';

export function generateLoader(shebang: string | null | undefined, loader: string) {
  return [
    shebang ? `${shebang}\n` : ``,
    `/* eslint-disable */\n`,
    `"use strict";\n`,
    `\n`,
    loader,
    `\n`,
    getTemplate(),
  ].join(``);
}

function generateJsonString(data: SerializedState) {
  return JSON.stringify(data, null, 2);
}

function generateStringLiteral(value: string) {
  return `'${
    value
      .replace(/\\/g, `\\\\`)
      .replace(/'/g, `\\'`)
      .replace(/\n/g, `\\\n`)
  }'`;
}

function generateInlinedSetup(data: SerializedState) {
  return [
    `const RAW_RUNTIME_STATE =\n`,
    `${generateStringLiteral(generatePrettyJson(data))};\n\n`,
    `function $$SETUP_STATE(hydrateRuntimeState, basePath) {\n`,
    `  return hydrateRuntimeState(JSON.parse(RAW_RUNTIME_STATE), {basePath: basePath || __dirname});\n`,
    `}\n`,
  ].join(``);
}

function generateSplitSetup(dataLocation: string) {
  return [
    `function $$SETUP_STATE(hydrateRuntimeState, basePath) {\n`,
    `  const path = require('path');\n`,
    `  const dataLocation = path.resolve(__dirname, ${JSON.stringify(dataLocation)});\n`,
    `  return hydrateRuntimeState(require(dataLocation), {basePath: basePath || path.dirname(dataLocation)});\n`,
    `}\n`,
  ].join(``);
}

export function generateInlinedScript(settings: PnpSettings): string {
  const data = generateSerializedState(settings);

  const setup = generateInlinedSetup(data);
  const loaderFile = generateLoader(settings.shebang, setup);

  return loaderFile;
}

export function generateSplitScript(settings: PnpSettings & {dataLocation: string}): {dataFile: string, loaderFile: string} {
  const data = generateSerializedState(settings);

  const setup = generateSplitSetup(settings.dataLocation);
  const loaderFile = generateLoader(settings.shebang, setup);

  return {dataFile: generateJsonString(data), loaderFile};
}
