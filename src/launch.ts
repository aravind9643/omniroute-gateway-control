// Pure helpers for starting OmniRoute (no vscode import; unit-tested).

export type LaunchMode = "npx" | "global" | "docker" | "custom";

export const DOCKER_IMAGE = "diegosouzapw/omniroute";
export const DOCKER_CONTAINER = "omniroute";

/** The shell command that starts OmniRoute for a launch mode (shown to the user before it runs). */
export function launchCommand(mode: LaunchMode, port: number, custom: string, localhostOnly: boolean): string {
  switch (mode) {
    case "global":
      return "omniroute serve";
    case "docker":
      return [
        "docker run -d --rm",
        `--name ${DOCKER_CONTAINER}`,
        `-p ${localhostOnly ? "127.0.0.1:" : ""}${port}:20128`,
        "-e DATA_DIR=/data -v omniroute-data:/data",
        DOCKER_IMAGE,
      ].join(" ");
    case "custom":
      return custom.trim();
    default:
      return "npx -y omniroute serve";
  }
}
