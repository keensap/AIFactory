/** A partial layer of overrides, with no defaults applied. */
export interface ProcessParams {
  review?: { maxFindings?: number };
  revision?: { maxGrowthRatio?: number };
  context?: { analysisChars?: number; baselineChars?: number; attachmentChars?: number };
  prompt?: { extraInstructions?: string };
}

export class ProcessParamsError extends Error {
  readonly code = 'INVALID_PROCESS_PARAMS';
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ProcessParamsError';
    this.path = path;
  }
}

function objectAt(value: unknown, path: string): object {
  if (typeof value === 'object' && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
  }
  throw new ProcessParamsError(path, 'expected a plain object');
}

function fieldsAt<K extends string>(value: unknown, path: string, allowed: readonly K[]): [K, unknown][] {
  const object = objectAt(value, path);
  return Reflect.ownKeys(object).map(key => {
    const fieldPath = `${path}.${String(key)}`;
    if (typeof key !== 'string' || !allowed.includes(key as K)) {
      throw new ProcessParamsError(fieldPath, 'unknown key');
    }
    const field = Object.getOwnPropertyDescriptor(object, key);
    if (!field || !Object.hasOwn(field, 'value')) {
      throw new ProcessParamsError(fieldPath, 'expected a data property');
    }
    return [key as K, field.value];
  });
}

function boundedNumber(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isInteger(value))) {
    throw new ProcessParamsError(path, `expected ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

/** Validate and copy a layer. Unknown keys and explicitly invalid values are errors. */
export function parseProcessParams(value: unknown): ProcessParams {
  const result: ProcessParams = {};
  for (const [section, values] of fieldsAt(value, 'params', ['review', 'revision', 'context', 'prompt'])) {
    const path = `params.${section}`;
    switch (section) {
      case 'review': {
        result.review = {};
        for (const [, value] of fieldsAt(values, path, ['maxFindings'])) {
          result.review.maxFindings = boundedNumber(value, `${path}.maxFindings`, 1, 12, true);
        }
        break;
      }
      case 'revision': {
        result.revision = {};
        for (const [, value] of fieldsAt(values, path, ['maxGrowthRatio'])) {
          result.revision.maxGrowthRatio = boundedNumber(value, `${path}.maxGrowthRatio`, 1, 5);
        }
        break;
      }
      case 'context': {
        result.context = {};
        for (const [key, value] of fieldsAt(values, path, ['analysisChars', 'baselineChars', 'attachmentChars'])) {
          result.context[key] = boundedNumber(value, `${path}.${key}`, 0, 200_000, true);
        }
        break;
      }
      case 'prompt': {
        result.prompt = {};
        for (const [, value] of fieldsAt(values, path, ['extraInstructions'])) {
          if (typeof value !== 'string' || value.length > 4_000) {
            throw new ProcessParamsError(`${path}.extraInstructions`, 'expected a string of at most 4000 characters');
          }
          result.prompt.extraInstructions = value;
        }
        break;
      }
    }
  }
  return result;
}

/** Merge from lowest to highest precedence, validating even fields later overridden. */
export function mergeProcessParams(...layers: unknown[]): ProcessParams {
  const result: ProcessParams = {};
  for (const value of layers) {
    if (value === undefined) continue; // No layer at this precedence.
    const layer = parseProcessParams(value);
    if (layer.review !== undefined) result.review = { ...result.review, ...layer.review };
    if (layer.revision !== undefined) result.revision = { ...result.revision, ...layer.revision };
    if (layer.context !== undefined) result.context = { ...result.context, ...layer.context };
    if (layer.prompt !== undefined) result.prompt = { ...result.prompt, ...layer.prompt };
  }
  return result;
}
