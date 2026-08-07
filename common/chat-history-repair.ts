export interface RepairHistoryAcceptNativeRequest {
  action: 'accept-native';
  chatId: string;
  expectedCarryOverRevision: string;
  expectedAgentOwnershipEpoch: string;
}

export interface RepairHistoryAcceptNativeResponse {
  success: true;
  action: 'accept-native';
  chatId: string;
  receiptCleared: boolean;
}
