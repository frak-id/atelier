export type ConfigFileContentType = "json" | "text" | "binary";
export type ConfigFileScope = "global" | "workspace";

export interface ConfigFile {
  id: string;
  path: string;
  content: string;
  contentType: ConfigFileContentType;
  scope: ConfigFileScope;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConfigFileOptions {
  path: string;
  content: string;
  contentType: ConfigFileContentType;
  scope: ConfigFileScope;
  workspaceId?: string;
}

export interface UpdateConfigFileOptions {
  content?: string;
  contentType?: ConfigFileContentType;
}

export interface MergedConfigFile {
  path: string;
  content: string;
  contentType: ConfigFileContentType;
}
