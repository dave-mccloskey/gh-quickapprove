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
  state: string;
  merged: boolean;
  user: GitHubUser;
  head: {sha: string};
}

export interface Review {
  id: number;
  state: string;
  user: GitHubUser;
  commit_id: string;
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
}

export interface MessageSender {
  id?: string;
  url?: string;
  frameId?: number;
  documentId?: string;
  tab?: {id?: number};
}

export interface GitHubApi {
  user(token: string): Promise<GitHubUser>;
  pull(target: PrTarget, token: string): Promise<PullRequest>;
  reviews(target: PrTarget, token: string): Promise<Review[]>;
  approve(target: PrTarget, sha: string, token: string): Promise<Review>;
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
}
