import type {DiagnosticTrace} from './diagnostics.js';

export interface PrTarget {
  owner: string;
  repo: string;
  number: number;
  key: string;
}

export interface GitHubUser {
  id: number;
  login: string;
}

export interface PullRequest {
  id: number;
  nodeId: string;
  state: string;
  merged: boolean;
  user: GitHubUser;
  head: {sha: string};
}

export interface Review {
  id: number;
  state: string;
  user: GitHubUser;
}

export interface ViewState {
  kind: string;
  label: string;
  sha?: string;
  login?: string;
}

export interface Credential {
  token: string;
  user: GitHubUser;
  generation: string;
  invalid: boolean;
}

export interface Attempt {
  id: string;
  accountId: number;
  prId: number;
  target: PrTarget;
  sha: string;
  reviewIds: number[];
}

export interface ExtensionMessage {
  op: string;
  pageUser?: string;
  generation?: number;
  sha?: string;
  token?: string;
  traceId?: string;
}

export interface MessageSender {
  id?: string;
  url?: string;
  frameId?: number;
  documentId?: string;
  tab?: {id?: number; url?: string};
}

export interface GitHubApi {
  user(token: string, traceId?: string): Promise<GitHubUser>;
  pull(target: PrTarget, token: string, traceId?: string): Promise<PullRequest>;
  reviews(target: PrTarget, token: string, author: string, traceId?: string): Promise<Review[]>;
  approve(
    pullRequestId: string,
    sha: string,
    token: string,
    traceId?: string,
  ): Promise<Pick<Review, 'id' | 'state'>>;
}

export interface ExtensionStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ServiceDependencies {
  storage: ExtensionStorage;
  api: GitHubApi;
  verifyContext(sender: MessageSender, message: ExtensionMessage): Promise<boolean>;
  notify(): Promise<void>;
  openSettings(): Promise<void>;
  extensionId: string;
  trace?: DiagnosticTrace;
}
