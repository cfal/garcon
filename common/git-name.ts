import { isRecord } from './json.js';

export const GIT_NAME_DESCRIPTION_LIMIT = 2_000;
export const GIT_NAME_LIMIT = 64;

export interface GenerateGitNameRequest {
  description: string;
  previousName: string;
}

export interface GenerateGitNameResponse {
  name: string;
}

export function isGenerateGitNameRequest(value: unknown): value is GenerateGitNameRequest {
  return isRecord(value) && Object.keys(value).every(key => key === 'description' || key === 'previousName')
    && typeof value.description === 'string' && value.description.length <= GIT_NAME_DESCRIPTION_LIMIT
    && typeof value.previousName === 'string' && value.previousName.length <= GIT_NAME_LIMIT;
}
