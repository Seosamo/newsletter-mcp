import type { ContentProviderResult, ContentSearchInput } from "../domain/types.js";

export interface ContentProvider {
  readonly name: string;
  search(input: ContentSearchInput): Promise<ContentProviderResult>;
}
