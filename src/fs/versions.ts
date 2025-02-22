import { Maybe } from "../common/index.js"


// TYPES
export type SemVer = {
  major: number
  minor: number
  patch: number
}


// FUNCTIONS
export const encode = (major: number, minor: number, patch: number): SemVer => {
  return {
    major,
    minor,
    patch
  }
}

export const fromString = (str: string): Maybe<SemVer> => {
  const parts = str.split(".").map(x => parseInt(x)) // dont shorten this because parseInt has a second param
  if (parts.length !== 3 || parts.some(p => typeof p !== "number")) {
    return null
  }
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2]
  }
}

export const toString = (version: SemVer): string => {
  const { major, minor, patch } = version
  return `${major}.${minor}.${patch}`
}

export const isSmallerThan = (a: SemVer, b: SemVer): boolean => {
  if (a.major != b.major) return a.major < b.major
  if (a.minor != b.minor) return a.minor < b.minor
  return a.patch < b.patch
}


// VERSIONS
export const v0 = encode(0, 0, 0)
export const v1 = encode(1, 0, 0)
export const latest = encode(2, 0, 0)
