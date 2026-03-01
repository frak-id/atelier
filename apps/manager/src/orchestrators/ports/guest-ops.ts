import * as _base from "./guest-base.ts";
import * as _repo from "./guest-repo.ts";
import * as _secrets from "./guest-secrets.ts";

export const GuestOps = {
  ..._base,
  ..._repo,
  ..._secrets,
};
