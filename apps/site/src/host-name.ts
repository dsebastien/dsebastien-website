/** A host name in small letters, with a top-level domain: the form of a host of a target and of a site id. */
export const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u
