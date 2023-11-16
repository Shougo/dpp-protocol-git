import { Denops, vars } from "https://deno.land/x/dpp_vim@v0.0.7/deps.ts";
import {
  BaseProtocol,
  Command,
  Plugin,
  ProtocolOptions,
} from "https://deno.land/x/dpp_vim@v0.0.7/types.ts";
import {
  isDirectory,
  safeStat,
} from "https://deno.land/x/dpp_vim@v0.0.7/utils.ts";
import { isAbsolute } from "https://deno.land/std@0.206.0/path/mod.ts";

type Params = {
  cloneDepth: number;
  commandPath: string;
  defaultBranch: string;
  defaultHubSite: string;
  defaultProtocol: string;
  defaultRemote: string;
  partialClone: boolean;
  pullArgs: string[];
};

type GitPlugin = Plugin & {
  __gitDefaultBranch?: string;
  __gitRemote?: string;
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
          frozen: true,
          local: true,
          path,
        };
      }
    }

    const url = await this.getUrl(args);
    if (url.length === 0) {
      return;
    }

    const directory = url.replace(/\.git$/, "").replace(/^https:\/+|^git@/, "")
      .replace(/:/, "/");

    return {
      path: `${await vars.g.get(
        args.denops,
        "dpp#_base_path",
      )}/repos/${directory}`,
    };
  }

  override async getUrl(args: {
    denops: Denops;
    plugin: Plugin;
    protocolOptions: ProtocolOptions;
    protocolParams: Params;
  }): Promise<string> {
    if (!args.plugin.repo || !args.plugin.repo.match(/\//)) {
      return "";
    }

    let protocol = args.protocolParams.defaultProtocol;
    let host = args.protocolParams.defaultHubSite;
    let name = args.plugin.repo;

    const sshMatch = args.plugin.repo.match(/^git@(?<host>[^:]+):(?<name>.+)/);
    const protocolMatch = args.plugin.repo.match(
      /^(?<protocol>[^:]+):\/\/(?<host>[^\/]+)\/(?<name>.+)/,
    );
    if (sshMatch && sshMatch.groups) {
      // Parse "git@host:name" pattern
      protocol = "ssh";
      host = sshMatch.groups.host;
      name = sshMatch.groups.name;
    } else if (protocolMatch && protocolMatch.groups) {
      // Parse "protocol://host/name" pattern
      protocol = protocolMatch.groups.protocol;
      host = protocolMatch.groups.host;
      name = protocolMatch.groups.name;
    }

    if (protocol !== "https" && protocol !== "ssh") {
      await args.denops.call(
        "dpp#util#_error",
        `Invalid git protocol: "${protocol}"`,
      );

      return "";
    }

    const url = (protocol === "ssh")
      ? `git@${host}:${name}`
      : `${protocol}://${host}/${name}`;

    return url;
  }

  override async getSyncCommands(args: {
    denops: Denops;
    plugin: GitPlugin;
    protocolOptions: ProtocolOptions;
    protocolParams: Params;
  }): Promise<Command[]> {
    if (!args.plugin.repo || !args.plugin.path) {
      return [];
    }

    const depth = args.protocolParams.cloneDepth;

    if (await isDirectory(args.plugin.path)) {
      const fetchArgs = [
        "-c",
        "credential.helper=",
        "fetch",
      ];

      const remoteArgs = [
        "remote",
        "set-head",
        args.plugin.__gitRemote ?? args.protocolParams.defaultRemote,
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
        "-c",
        "credential.helper=",
        "clone",
        "--recursive",
      ];

      if (args.protocolParams.partialClone) {
        commandArgs.push("--filter=blob:none");
      }

      if (depth && depth > 0) {
        commandArgs.push(`--depth=${depth}`);

        if (args.plugin.rev && args.plugin.rev.length > 0) {
          commandArgs.push("--branch");
          commandArgs.push(args.plugin.rev);
        }
      }

      commandArgs.push(await this.getUrl(args));
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
    plugin: GitPlugin;
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
        rev = args.plugin.__gitDefaultBranch ??
          args.protocolParams.defaultBranch;
      }
    }

    return [{
      command: args.protocolParams.commandPath,
      args: [
        "checkout",
        rev,
        "--",
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
      partialClone: false,
      pullArgs: ["pull", "--ff", "--ff-only"],
    };
  }
}

async function getGitDir(base: string): Promise<string> {
  // TODO: parse "." file
  return await isDirectory(`${base}/.git`) ? `${base}/.git` : "";
}
