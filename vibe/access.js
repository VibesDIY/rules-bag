// Every document here is written by backend.js — rule settings by POST /config,
// review records by the GitHub delivery (which runs as the person who connected
// the repo) or by POST /review. The browser never writes them directly, and
// each lands in the channel of the person who connected that repo, who is
// the only one who reads or writes it.
export default function (doc, oldDoc, user, ctx) {
  if (doc.type === "repo-config" || doc.type === "review") {
    ctx.requireBackend("fetch");
    if (!user) throw { forbidden: "sign in" };
    const binder = doc.binderHandle;
    if (typeof binder !== "string" || binder === "") throw { forbidden: "missing binder" };
    if (oldDoc && oldDoc.binderHandle !== binder) throw { forbidden: "binder is fixed" };
    if (binder !== user.userHandle) throw { forbidden: "not your repo" };
    const ch = "repo-of:" + binder;
    return { channels: [ch], grant: { users: { [binder]: [ch] } } };
  }
  throw { forbidden: "unknown document type" };
}
