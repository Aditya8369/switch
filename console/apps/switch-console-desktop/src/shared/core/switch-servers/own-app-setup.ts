/** A Slack app of your own: Slack's create-app page, filled in for this server. */
export type SlackOwnAppSetup = { createUrl: string };

/** Both tokens of a Slack app work, and the workspace they belong to. */
export type SlackTokensChecked = { workspaceId: string; workspaceName: string; botName: string };

/** A Discord application, read from its bot token. */
export type DiscordTokenChecked = {
  applicationId: string;
  name: string;
  /** The two privileged intents Switch needs, as the developer portal has them. */
  messageContent: boolean;
  serverMembers: boolean;
  /** Adds the bot to a server with the permissions Switch needs. */
  inviteUrl: string;
  /** The servers the bot is in now. */
  servers: { id: string; name: string }[];
};
