import { SentinelRule } from '../../memory/emailSentinel.js';

export interface EmailMetadata {
  id: string;
  threadId?: string;
  sender: string;
  fromName?: string;
  fromEmail?: string;
  to?: string;
  subject: string;
  date?: string;
  snippet: string;
  bodyText?: string;
  hasPriorityRule?: boolean;
  priorityReason?: string;
}

export interface FilteredEmail {
  email: EmailMetadata;
  passed: boolean;
  reason: string;
  ruleMatched?: SentinelRule;
}

export interface EmailAnalysisResult {
  emailId: string;
  sender: string;
  subject: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  isImportant: boolean;
  summary: string;
  actionRequired: string;
  reason: string;
}

export interface SentinelScanStats {
  totalUnread: number;
  newUnread: number;
  heuristicFiltered: number;
  analyzedWithLLM: number;
  importantEmailsCount: number;
  alertSent: boolean;
  timestamp: string;
}
