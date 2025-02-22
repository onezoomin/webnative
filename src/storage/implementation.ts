import { IMPLEMENTATION } from "./browser.js"
import { Implementation } from "./implementation/types.js"


export let impl: Implementation = IMPLEMENTATION


export function set(i: Partial<Implementation>): void { impl = { ...impl, ...i } }
