export type ConfigFileContentType = "json" | "text" | "binary";
export type ConfigFileScope = "global" | "project";

export interface ConfigFile {
  id: string;
  path: string;
  content: string;
  contentType: ConfigFileContentType;
  scope: ConfigFileScope;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConfigFileOptions {
  path: string;
  content: string;
  contentType: ConfigFileContentType;
  scope: ConfigFileScope;
  projectId?: string;
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
