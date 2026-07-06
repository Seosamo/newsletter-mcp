import type { NewsletterStorage } from "../storage/NewsletterStorage.js";
import type { AuthenticatedUser } from "./oauth.js";

export async function listResources(storage: NewsletterStorage, auth?: AuthenticatedUser) {
  const profiles = await storage.listProfiles();
  const templates = await storage.listTemplates();
  const historyUsers = await storage.listHistoryUsers();
  const visibleProfiles = auth ? profiles.filter((profile) => profile.userId === auth.userId) : profiles;
  const visibleHistoryUsers = auth ? historyUsers.filter((userId) => userId === auth.userId) : historyUsers;
  const categoryUsers = new Set([
    ...visibleProfiles.map((profile) => profile.userId),
    ...visibleHistoryUsers
  ]);

  return {
    resources: [
      {
        uri: "newsletter://templates",
        name: "Newsletter templates",
        mimeType: "application/json"
      },
      ...templates.map((template) => ({
        uri: `newsletter://templates/${template.templateId}`,
        name: `Newsletter template: ${template.templateId}`,
        mimeType: "application/json"
      })),
      ...visibleProfiles.map((profile) => ({
        uri: `newsletter://profiles/${profile.userId}`,
        name: `Newsletter profile: ${profile.userId}`,
        mimeType: "application/json"
      })),
      ...[...categoryUsers].map((userId) => ({
        uri: `newsletter://categories/${userId}`,
        name: `Interest tag settings: ${userId}`,
        mimeType: "application/json"
      })),
      ...visibleHistoryUsers.map((userId) => ({
        uri: `newsletter://history/${userId}`,
        name: `Newsletter history: ${userId}`,
        mimeType: "application/json"
      }))
    ]
  };
}

export function listResourceTemplates() {
  return {
    resourceTemplates: [
      {
        uriTemplate: "newsletter://profiles/{userId}",
        name: "User newsletter profile",
        mimeType: "application/json"
      },
      {
        uriTemplate: "newsletter://categories/{userId}",
        name: "User dynamic interest tag settings",
        mimeType: "application/json"
      },
      {
        uriTemplate: "newsletter://history/{userId}",
        name: "User newsletter generation history",
        mimeType: "application/json"
      },
      {
        uriTemplate: "newsletter://templates/{templateId}",
        name: "Newsletter template",
        mimeType: "application/json"
      }
    ]
  };
}

export async function readResource(storage: NewsletterStorage, uri: string, auth?: AuthenticatedUser) {
  const [kind, id] = parseNewsletterUri(uri);

  if (kind === "templates" && !id) {
    return resourceContents(uri, { templates: await storage.listTemplates() });
  }

  if (kind === "templates" && id) {
    const template = await storage.getTemplate(id);
    if (!template) {
      throw new Error(`Template not found: ${id}`);
    }
    return resourceContents(uri, { template });
  }

  if (kind === "profiles" && id) {
    assertCanAccessUserResource(id, auth);
    const profile = await storage.getProfile(id);
    if (!profile) {
      throw new Error(`Profile not found: ${id}`);
    }
    return resourceContents(uri, { profile });
  }

  if (kind === "categories" && id) {
    assertCanAccessUserResource(id, auth);
    return resourceContents(uri, {
      userId: id,
      settings: await storage.listUserCategorySettings(id)
    });
  }

  if (kind === "history" && id) {
    assertCanAccessUserResource(id, auth);
    return resourceContents(uri, {
      userId: id,
      history: await storage.listHistory(id)
    });
  }

  throw new Error(`Unsupported resource URI: ${uri}`);
}

function assertCanAccessUserResource(userId: string, auth?: AuthenticatedUser): void {
  if (!auth || auth.userId === userId) {
    return;
  }
  throw new Error("Authenticated user cannot access another user's newsletter resource.");
}

function resourceContents(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function parseNewsletterUri(uri: string): [string, string | undefined] {
  const prefix = "newsletter://";
  if (!uri.startsWith(prefix)) {
    throw new Error(`Invalid newsletter URI: ${uri}`);
  }
  const [kind, ...rest] = uri.slice(prefix.length).split("/");
  return [kind, rest.length > 0 ? decodeURIComponent(rest.join("/")) : undefined];
}
