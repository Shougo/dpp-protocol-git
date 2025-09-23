import { type Plugin, type ProtocolOptions } from "@shougo/dpp-vim/types";
import { BaseProtocol, type Command } from "@shougo/dpp-vim/protocol";
import { isDirectory, safeStat } from "@shougo/dpp-vim/utils";

import type { Denops } from "@denops/std";
import * as vars from "@denops/std/variable";

import { isAbsolute } from "@std/path/is-absolute";
import { assertEquals } from "@std/assert/equals";

export type Params = {
  cloneDepth: number;
  commandPath: string;
  defaultBranch: string;
  defaultHubSite: string;
  defaultProtocol: string;
  defaultRemote: string;
  enableCredentialHelper: boolean;
  enablePartialClone: boolean;
  enableSSLVerify: boolean;
  pullArgs: string[];
};

export type Attrs = {
  gitDefaultBranch?: string;
  gitRemote?: string;
};

export class Protocol extends BaseProtocol<Params> {
  override async detect(args: {
    denops: Denops;
    plugin: Plugin;
    protocolOptions: ProtocolOptions;
    protocolParams: Params;
  }): Promise<Partial<Plugin> | undefined> {
    if (!args.plugin.repo) {
      return;
    }

    if (
      args.plugin.repo.match(
        /\/\/(raw|gist)\.githubusercontent\.com\/|\/archive\/[^\/]+.zip$/,
      )
    ) {
      // Raw repository
      return;
    }

    if (isAbsolute(args.plugin.repo) || args.plugin.repo.match(/^~/)) {
      if (args.plugin.local) {
        // Already local
        return;
      }

      const path = await args.denops.call(
        "dpp#util#_expand",
        args.plugin.repo,
      ) as string;

      if (await isDirectory(path)) {
        // Local repository
        return {
          local: true,
          path,
        };
      }
    }

    const url = this.getUrl(args);
    if (url.length === 0) {
      return;
    }

    // NOTE: github acceleration URL may include https:// in URL
    const directory = url.replace(/\.git$/, "").replace(/https:\/+|^git@/g, "")
      .replace(/:/, "/");

    const browseUrl = url.replace(/^git@github.com:/, "https://github.com/")
      .replace(/^git@git.sr.ht:/, "https://git.sr.ht").replace(/\.git$/, "");

    return {
      path: `${await vars.g.get(
        args.denops,
        "dpp#_base_path",
      )}/repos/${directory}`,
      url: browseUrl,
    };
  }

  override getUrl(args: {
    denops: Denops;
    plugin: Plugin;
    protocolOptions: ProtocolOptions;
    protocolParams: Params;
  }): string {
    return getGitUrl(
      args.plugin,
      args.protocolParams.defaultHubSite,
      args.protocolParams.defaultProtocol,
    );
  }

  override async getSyncCommands(args: {
    denops: Denops;
    plugin: Plugin;
    protocolOptions: ProtocolOptions;
    protocolParams: Params;
  }): Promise<Command[]> {
    if (!args.plugin.repo || !args.plugin.path) {
      return [];
    }

    const depth = args.protocolParams.cloneDepth;
    const credentialHelper = args.protocolParams.enableCredentialHelper ? [] : [
      "-c",
      "credential.helper=",
      "-c",
      "core.fsmonitor=false",
    ];
    const sslVerify = args.protocolParams.enableSSLVerify ? [] : [
      "-c",
      "http.sslVerify=false",
    ];

    const initArgs = [...credentialHelper, ...sslVerify];

    if (await isDirectory(args.plugin.path)) {
      const fetchArgs = [...initArgs, "fetch"];

      const attrs = args.plugin?.protocolAttrs as Attrs;

      const remoteArgs = [
        "remote",
        "set-head",
        attrs?.gitRemote ?? args.protocolParams.defaultRemote,
        "-a",
      ];

      const submoduleArgs = [
        "submodule",
        "update",
        "--init",
        "--recursive",
      ];

      const commands = [];

      commands.push(
        {
          command: args.protocolParams.commandPath,
          args: fetchArgs,
        },
      );

      if (!depth && depth <= 0) {
        commands.push(
          {
            command: args.protocolParams.commandPath,
            args: remoteArgs,
          },
        );
      }

      commands.push(
        {
          command: args.protocolParams.commandPath,
          args: args.protocolParams.pullArgs,
        },
      );

      commands.push(
        {
          command: args.protocolParams.commandPath,
          args: submoduleArgs,
        },
      );

      return commands;
    } else {
      const commandArgs = [
        ...initArgs,
        "clone",
        "--recursive",
      ];

      if (args.protocolParams.enablePartialClone) {
        commandArgs.push("--filter=blob:none");
      }

      if (depth && depth > 0) {
        commandArgs.push(`--depth=${depth}`);

        if (args.plugin.rev && args.plugin.rev.length > 0) {
          commandArgs.push("--branch");
          commandArgs.push(args.plugin.rev);
        }
      }

      commandArgs.push(this.getUrl(args));
      commandArgs.push(args.plugin.path);

      return [{
        command: args.protocolParams.commandPath,
        args: commandArgs,
      }];
    }
  }

  override getRollbackCommands(args: {
    denops: Denops;
    plugin: Plugin;
    protocolParams: Params;
    rev: string;
  }): Command[] {
    if (!args.plugin.repo || !args.plugin.path) {
      return [];
    }

    return [{
      command: args.protocolParams.commandPath,
      args: [
        "reset",
        "--hard",
        args.rev,
      ],
    }];
  }

  override getDiffCommands(args: {
    denops: Denops;
    plugin: Plugin;
    protocolParams: Params;
    newRev: string;
    oldRev: string;
  }): Command[] {
    if (!args.plugin.repo || !args.plugin.path) {
      return [];
    }

    return [{
      command: args.protocolParams.commandPath,
      args: [
        "diff",
        `${args.oldRev}..${args.newRev}`,
        "--",
        "doc",
        "README",
        "README.md",
      ],
    }];
  }

  override async getLogCommands(args: {
    denops: Denops;
    plugin: Plugin;
    protocolParams: Params;
    newRev: string;
    oldRev: string;
  }): Promise<Command[]> {
    if (
      !args.plugin.repo || !args.plugin.path || args.newRev.length === 0 ||
      args.oldRev.length === 0
    ) {
      return [];
    }

    // NOTE: If the oldRev is not the ancestor of two branches. Then do not use
    // %s^.  use %s^ will show one commit message which already shown last
    // time.
    const proc = new Deno.Command(
      args.protocolParams.commandPath,
      {
        args: [
          "merge-base",
          args.oldRev,
          args.newRev,
        ],
        cwd: await isDirectory(args.plugin.path ?? "")
          ? args.plugin.path
          : Deno.cwd(),
        stdout: "piped",
        stderr: "piped",
      },
    );
    const { stdout } = await proc.output();

    const isNotAncestor = new TextDecoder().decode(stdout) === args.oldRev;
    return [{
      command: args.protocolParams.commandPath,
      args: [
        "log",
        `${args.oldRev}${isNotAncestor ? "" : "^"}..${args.newRev}`,
        "--graph",
        "--no-show-signature",
        '--pretty=format:"%h [%cr] %s"',
      ],
    }];
  }

  override async getRevisionLockCommands(args: {
    denops: Denops;
    plugin: Plugin;
    protocolParams: Params;
  }): Promise<Command[]> {
    if (!args.plugin.repo || !args.plugin.path) {
      return [];
    }

    let rev = args.plugin.rev ?? "";

    if (rev && rev.match(/\*/)) {
      // Use the released tag (git 1.9.2 or above required)
      const proc = new Deno.Command(
        args.protocolParams.commandPath,
        {
          args: [
            "tag",
            rev,
            "--list",
            "--sort",
            "-version:refname",
          ],
          cwd: await isDirectory(args.plugin.path ?? "")
            ? args.plugin.path
            : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      );
      const { stdout } = await proc.output();

      const lines = new TextDecoder().decode(stdout).split("\n");
      rev = lines.length > 0 ? lines[0] : "";
    }

    if (rev.length === 0) {
      // Fix detach HEAD.
      // Use symbolic-ref feature (git 1.8.7 or above required)
      const proc = new Deno.Command(
        args.protocolParams.commandPath,
        {
          args: [
            "symbolic-ref",
            "--short",
            "HEAD",
          ],
          cwd: await isDirectory(args.plugin.path ?? "")
            ? args.plugin.path
            : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      );
      const { stdout } = await proc.output();

      const lines = new TextDecoder().decode(stdout).split("\n");
      rev = lines.length > 0 ? lines[0] : "";

      if (rev.match(/fatal: /)) {
        // Fix "fatal: ref HEAD is not a symbolic ref" error
        const attrs = args.plugin?.protocolAttrs as Attrs;
        rev = attrs?.gitDefaultBranch ?? args.protocolParams.defaultBranch;
      }
    }

    return [{
      command: args.protocolParams.commandPath,
      args: [
        "checkout",
        "--quiet",
        "--guess",
        rev,
        "--",
      ],
    }];
  }

  override getChangesCountCommands(args: {
    denops: Denops;
    plugin: Plugin;
    protocolParams: Params;
    newRev: string;
    oldRev: string;
  }): Command[] {
    if (!args.plugin.repo || !args.plugin.path) {
      return [];
    }

    return [{
      command: args.protocolParams.commandPath,
      args: [
        "rev-list",
        "--count",
        `${args.oldRev}..${args.newRev}`,
      ],
    }];
  }

  override async getRevision(args: {
    denops: Denops;
    plugin: Plugin;
  }): Promise<string> {
    if (!args.plugin.repo || !args.plugin.path) {
      return "";
    }

    const gitDir = await getGitDir(args.plugin.path);
    if (gitDir.length === 0) {
      return "";
    }
    const headFileLine =
      (await Deno.readTextFile(`${gitDir}/HEAD`)).split("\n")[0];

    if (headFileLine.startsWith("ref: ")) {
      const ref = headFileLine.slice(5);
      if (await safeStat(`${gitDir}/${ref}`)) {
        return (await Deno.readTextFile(`${gitDir}/${ref}`)).split("\n")[0];
      }

      for (
        const line of (await Deno.readTextFile(`${gitDir}/packed-refs`)).split(
          "\n",
        ).filter(
          (line) => line.includes(` ${ref}`),
        )
      ) {
        return line.replace(/^([0-9a-f]*) /, "$1");
      }
    }

    return headFileLine;
  }

  override params(): Params {
    return {
      cloneDepth: 0,
      commandPath: "git",
      defaultBranch: "main",
      defaultHubSite: "github.com",
      defaultProtocol: "https",
      defaultRemote: "origin",
      enableCredentialHelper: false,
      enablePartialClone: false,
      enableSSLVerify: true,
      pullArgs: ["pull", "--ff", "--ff-only"],
    };
  }
}

function getGitUrl(
  plugin: Plugin,
  defaultHubSite: string,
  defaultProtocol: string,
): string {
  if (!plugin.repo || !plugin.repo.match(/\//)) {
    return "";
  }

  let protocol = defaultProtocol;
  let host = defaultHubSite;
  let user = "";
  let name = "";

  const sshMatch = plugin.repo.match(
    /^git@(?<host>[^:]+):(?<user>[^\/]+)\/(?<name>.+)/,
  );
  const protocolMatch = plugin.repo.match(
    /^(?<protocol>[^:]+):\/\/(?<host>[^\/]+)\/(?<user>[^\/]+)\/(?<name>.+)/,
  );
  const hostMatch = plugin.repo.match(
    /^((?<host>[^\/]+)\/)?(?<user>[^\/]+)\/(?<name>.+)/,
  );
  if (sshMatch && sshMatch.groups) {
    // Parse "git@host:user/name" pattern
    protocol = "ssh";
    host = sshMatch.groups.host;
    user = sshMatch.groups.user;
    name = sshMatch.groups.name;
  } else if (protocolMatch && protocolMatch.groups) {
    // Parse "protocol://host/user/name" pattern
    protocol = protocolMatch.groups.protocol;
    host = protocolMatch.groups.host;
    user = protocolMatch.groups.user;
    name = protocolMatch.groups.name;
  } else if (hostMatch && hostMatch.groups) {
    // Parse "host/user/name" pattern
    if (hostMatch.groups.host) {
      host = hostMatch.groups.host;
    }
    user = hostMatch.groups.user;
    name = hostMatch.groups.name;
  }

  if (user === "" || name === "") {
    // Invalid
    return "";
  }

  if (protocol !== "https" && protocol !== "ssh") {
    // Invalid protocol
    return "";
  }

  const url = (protocol === "ssh")
    ? `git@${host}:${user}/${name}`
    : `${protocol}://${host}/${user}/${name}`;

  // NOTE: "git.sr.ht" does not support ".git" url!
  return host === "git.sr.ht" || url.endsWith(".git") ? url : url + ".git";
}

async function getGitDir(base: string): Promise<string> {
  // TODO: parse "." file
  return await isDirectory(`${base}/.git`) ? `${base}/.git` : "";
}

Deno.test("getGitUrl", () => {
  assertEquals(
    getGitUrl(
      {
        name: "dpp.vim",
        repo: "Shougo/dpp.vim",
      },
      "github.com",
      "https",
    ),
    "https://github.com/Shougo/dpp.vim.git",
  );

  assertEquals(
    getGitUrl(
      {
        name: "repo",
        repo: "gitlab.com/user/repo",
      },
      "github.com",
      "https",
    ),
    "https://gitlab.com/user/repo.git",
  );

  assertEquals(
    getGitUrl(
      {
        name: "repo",
        repo: "https://gitlab.com/user/repo",
      },
      "github.com",
      "https",
    ),
    "https://gitlab.com/user/repo.git",
  );

  assertEquals(
    getGitUrl(
      {
        name: "repo",
        repo: "foo://gitlab.com/user/repo",
      },
      "github.com",
      "https",
    ),
    "",
  );

  assertEquals(
    getGitUrl(
      {
        name: "dpp.vim",
        repo: "https://github.com/Shougo/dpp.vim.git",
      },
      "github.com",
      "https",
    ),
    "https://github.com/Shougo/dpp.vim.git",
  );

  assertEquals(
    getGitUrl(
      {
        name: "dpp.vim",
        repo: "Shougo/dpp.vim",
      },
      "github.com",
      "ssh",
    ),
    "git@github.com:Shougo/dpp.vim.git",
  );

  assertEquals(
    getGitUrl(
      {
        name: "lsp_lines.nvim",
        repo: "~whynothugo/lsp_lines.nvim",
      },
      "git.sr.ht",
      "https",
    ),
    "https://git.sr.ht/~whynothugo/lsp_lines.nvim",
  );

  assertEquals(
    getGitUrl(
      {
        name: "lsp_lines.nvim",
        repo: "~whynothugo/lsp_lines.nvim",
      },
      "git.sr.ht",
      "ssh",
    ),
    "git@git.sr.ht:~whynothugo/lsp_lines.nvim",
  );
});
