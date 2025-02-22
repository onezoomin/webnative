import FileSystem from "../../fs/index.js"

import type { Channel, ChannelOptions } from "../channel"
import { Implementation } from "../implementation/types.js"
import { PermissionedAppInitOptions } from "../../init/types.js"

import * as check from "../../common/type-checks.js"
import { USERNAME_STORAGE_KEY, decodeCID } from "../../common/index.js"
import { scenarioAuthCancelled, scenarioAuthSucceeded, scenarioNotAuthorised, PermissionedAppState } from "../state/permissionedApp.js"
import { validateSecrets } from "../state.js"
import { loadFileSystem } from "../../filesystem.js"
import { setup } from "../../setup/internal.js"

import * as crypto from "../../crypto/index.js"
import * as did from "../../did/index.js"
import * as identifiers from "../../common/identifiers.js"
import * as common from "../../common/index.js"
import * as ipfs from "../../ipfs/index.js"
import * as pathing from "../../path.js"
import * as storage from "../../storage/index.js"
import * as ucan from "../../ucan/internal.js"
import * as user from "../../lobby/username.js"
import * as token from "../../ucan/token.js"
import * as channel from "../channel.js"
import { LinkingError } from "../linking.js"



export const init = async (options: PermissionedAppInitOptions): Promise<PermissionedAppState | null> => {
  const permissions = options.permissions || null
  const { autoRemoveUrlParams = true, rootKey } = options

  // TODO: should be shared?
  const maybeLoadFs = async (username: string): Promise<undefined | FileSystem> => {
    return options.loadFileSystem === false
      ? undefined
      : await loadFileSystem(permissions, username, rootKey)
  }

  // URL things
  const url = new URL(window.location.href)
  const authorised = url.searchParams.get("authorised")
  const cancellation = url.searchParams.get("cancelled")

  // Determine scenario
  if (authorised) {
    const newUser = url.searchParams.get("newUser") === "t"
    const username = url.searchParams.get("username") || ""

    await retry(async () => importClassifiedInfo(
      authorised === "via-postmessage"
        ? await getClassifiedViaPostMessage()
        : JSON.parse(await ipfs.cat(decodeCID(authorised))) // in any other case we expect it to be a CID
    ), { tries: 10, timeout: 10000, timeoutMessage: "Trying to retrieve UCAN(s) and readKey(s) from the auth lobby timed out after 10 seconds." })

    await storage.setItem(USERNAME_STORAGE_KEY, username)

    if (autoRemoveUrlParams) {
      url.searchParams.delete("authorised")
      url.searchParams.delete("newUser")
      url.searchParams.delete("username")
      history.replaceState(null, document.title, url.toString())
    }

    if (permissions && await validateSecrets(permissions) === false) {
      console.warn("Unable to validate filesystem secrets")
      return scenarioNotAuthorised(permissions)
    }

    if (permissions && ucan.validatePermissions(permissions, username) === false) {
      console.warn("Unable to validate UCAN permissions")
      return scenarioNotAuthorised(permissions)
    }

    return scenarioAuthSucceeded(
      permissions,
      newUser,
      username,
      await maybeLoadFs(username)
    )

  } else if (cancellation) {
    const c = (() => {
      switch (cancellation) {
        case "DENIED": return "User denied authorisation"
        default: return "Unknown reason"
      }
    })()

    return scenarioAuthCancelled(permissions, c)
  } else {
    await ucan.store([])
  }

  return null
}

export const register = async (options: { username: string; email?: string }): Promise<{ success: boolean }> => {
  return new Promise(resolve => resolve({ success: false }))
}

export const isUsernameValid = async (username: string): Promise<boolean> => {
  return user.isUsernameValid(username)
}

export const isUsernameAvailable = async (username: string): Promise<boolean> => {
  return user.isUsernameAvailable(username)
}

export const createChannel = (options: ChannelOptions): Promise<Channel> => {
  return channel.createWssChannel(options)
}

export const checkCapability = async (username: string): Promise<boolean> => {
  const readKey = await storage.getItem("readKey")
  if (!readKey) return false

  const didFromDNS = await did.root(username)
  const maybeUcan: string | null = await storage.getItem("ucan")

  if (maybeUcan) {
    const rootIssuerDid = token.rootIssuer(maybeUcan)
    const decodedUcan = token.decode(maybeUcan)
    const { ptc } = decodedUcan.payload

    return didFromDNS === rootIssuerDid && ptc === "SUPER_USER"
  } else {
    const rootDid = await did.write()

    return didFromDNS === rootDid
  }
}

export const delegateAccount = async (username: string, audience: string): Promise<Record<string, unknown>> => {
  const readKey = await storage.getItem("readKey")
  const proof = await storage.getItem("ucan") as string

  const u = await token.build({
    audience,
    issuer: await did.write(),
    lifetimeInSeconds: 60 * 60 * 24 * 30 * 12 * 1000, // 1000 years
    potency: "SUPER_USER",
    proof,

    // TODO: UCAN v0.7.0
    // proofs: [ await localforage.getItem("ucan") ]
  })

  return { readKey, ucan: token.encode(u) }
}

function isLobbyLinkingData(data: unknown): data is { readKey: string; ucan: string } {
  return check.isObject(data)
    && "readKey" in data && typeof data.readKey === "string"
    && "ucan" in data && typeof data.ucan === "string"
}

export const linkDevice = async (data: Record<string, unknown>): Promise<void> => {
  if (!isLobbyLinkingData(data)) {
    throw new LinkingError(`Consumer received invalid link device response from producer: Expected read key and ucan, but got ${JSON.stringify(data)}`)
  }

  const { readKey, ucan: encodedToken } = data
  const u = token.decode(encodedToken)

  if (await token.isValid(u)) {
    await storage.setItem("ucan", encodedToken)
    await storage.setItem("readKey", readKey)
  } else {
    throw new LinkingError(`Consumer received invalid link device response from producer. Given ucan is invalid: ${data.ucan}`)
  }
}



// 🛳


export const LOBBY_IMPLEMENTATION = {
  auth: {
    init,
    register,
    isUsernameValid,
    isUsernameAvailable,
    createChannel,
    checkCapability,
    delegateAccount,
    linkDevice
  }
}

// HELPERS


async function retry(action: () => Promise<void>, options: { tries: number; timeout: number; timeoutMessage: string }): Promise<void> {
  return await Promise.race([
    (async () => {
      let tryNum = 1
      while (tryNum <= options.tries) {
        try {
          await action()
          return
        } catch (e) {
          if (tryNum == options.tries) {
            throw e
          }
        }
        tryNum++
      }
    })(),
    new Promise<void>((resolve, reject) => setTimeout(() => reject(new Error(options.timeoutMessage)), options.timeout))
  ])
}

interface AuthLobbyClassifiedInfo {
  sessionKey: string
  secrets: string
  iv: string
}

function isAuthLobbyClassifiedInfo(obj: unknown): obj is AuthLobbyClassifiedInfo {
  return common.isObject(obj)
    && common.isString(obj.sessionKey)
    && common.isString(obj.secrets)
    && common.isString(obj.iv)
}

async function importClassifiedInfo(
  classifiedInfo: AuthLobbyClassifiedInfo
): Promise<void> {
  // Extract session key and its iv
  const rawSessionKey = await crypto.keystore.decrypt(classifiedInfo.sessionKey)

  // Decrypt secrets
  const secretsStr = await crypto.aes.decryptGCM(classifiedInfo.secrets, rawSessionKey, classifiedInfo.iv)
  const secrets = JSON.parse(secretsStr)

  const fsSecrets: Record<string, { key: string; bareNameFilter: string }> = secrets.fs
  const ucans = secrets.ucans

  // Import read keys and bare name filters
  await Promise.all(
    Object.entries(fsSecrets).map(async ([posixPath, { bareNameFilter, key }]) => {
      const path = pathing.fromPosix(posixPath)
      const readKeyId = await identifiers.readKey({ path })
      const bareNameFilterId = await identifiers.bareNameFilter({ path })

      await crypto.keystore.importSymmKey(key, readKeyId)
      await storage.setItem(bareNameFilterId, bareNameFilter)
    })
  )

  // Add UCANs to the storage
  await ucan.store(ucans)
}

async function getClassifiedViaPostMessage(): Promise<AuthLobbyClassifiedInfo> {
  const iframe: HTMLIFrameElement = await new Promise(resolve => {
    const iframe = document.createElement("iframe")
    iframe.id = "webnative-secret-exchange"
    iframe.style.width = "0"
    iframe.style.height = "0"
    iframe.style.border = "none"
    iframe.style.display = "none"
    document.body.appendChild(iframe)

    iframe.onload = () => {
      resolve(iframe)
    }

    iframe.src = `${setup.endpoints.lobby}/exchange.html`
  })

  try {

    const answer: Promise<AuthLobbyClassifiedInfo> = new Promise((resolve, reject) => {
      let tries = 10
      window.addEventListener("message", listen)

      function retryOrReject(eventData?: string) {
        console.warn(`When importing UCANs & readKey(s): Can't parse: ${eventData}. Might be due to extensions.`)
        if (--tries === 0) {
          window.removeEventListener("message", listen)
          reject(new Error("Couldn't parse message from auth lobby after 10 tries. See warnings above."))
        }
      }

      function listen(event: MessageEvent<string>) {
        if (new URL(event.origin).host !== new URL(setup.endpoints.lobby).host) {
          console.log(`Got a message from ${event.origin} while waiting for login credentials. Ignoring.`)
          return
        }

        if (event.data == null) {
          // Might be an extension sending a message without data
          return
        }

        let classifiedInfo: unknown = null
        try {
          classifiedInfo = JSON.parse(event.data)
        } catch {
          retryOrReject(event.data)
          return
        }

        if (!isAuthLobbyClassifiedInfo(classifiedInfo)) {
          retryOrReject(event.data)
          return
        }

        window.removeEventListener("message", listen)
        resolve(classifiedInfo)
      }
    })

    if (iframe.contentWindow == null) throw new Error("Can't import UCANs & readKey(s): No access to its contentWindow")
    const message = {
      webnative: "exchange-secrets",
      didExchange: await did.exchange()
    }
    iframe.contentWindow.postMessage(message, iframe.src)

    return await answer

  } finally {
    document.body.removeChild(iframe)
  }
}


