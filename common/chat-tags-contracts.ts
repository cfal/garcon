export interface SetChatTagsRequest {
  chatId: string;
  tags: string[];
}

export interface SetChatTagsResponse {
  success: true;
  chatId: string;
  tags: string[];
  changed: boolean;
}
