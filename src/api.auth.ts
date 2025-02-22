// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import { Account, accountCanLogin, changeSrpHelper, expandUsername, getAccount, getFromAccount } from './perm'
import { ApiError, ApiHandler } from './apiMiddleware'
import { SRPServerSessionStep1 } from 'tssrp6a'
import { ADMIN_URI, HTTP_UNAUTHORIZED, HTTP_BAD_REQUEST, HTTP_SERVER_ERROR, HTTP_CONFLICT, HTTP_NOT_FOUND } from './const'
import { ctxAdminAccess } from './adminApis'
import { failAllowNet, sessionDuration } from './middlewares'
import { getCurrentUsername, setLoggedIn, srpServerStep1 } from './auth'
import { defineConfig } from './config'
import events from './events'

const ongoingLogins:Record<string,SRPServerSessionStep1> = {} // store data that doesn't fit session object
const keepSessionAlive = defineConfig('keep_session_alive', true)

export const loginSrp1: ApiHandler = async ({ username }, ctx) => {
    if (!username)
        return new ApiError(HTTP_BAD_REQUEST)
    const account = getAccount(username)
    if (!ctx.session)
        return new ApiError(HTTP_SERVER_ERROR)
    if ((await events.emitAsync('attemptingLogin', { ctx, username }))?.isDefaultPrevented()) return
    if (!account || !accountCanLogin(account)) { // TODO simulate fake account to prevent knowing valid usernames
        ctx.logExtra({ u: username })
        ctx.state.dontLog = false // log even if log_api is false
        return new ApiError(HTTP_UNAUTHORIZED)
    }
    if (failAllowNet(ctx, account))
        return new ApiError(HTTP_UNAUTHORIZED)
    try {
        const { srpServer, ...rest } = await srpServerStep1(account)
        const sid = Math.random()
        ongoingLogins[sid] = srpServer
        setTimeout(()=> delete ongoingLogins[sid], 60_000)
        ctx.session.loggingIn = { username, sid } // temporarily store until process is complete
        return rest
    }
    catch (code: any) {
        return new ApiError(code)
    }
}

export const loginSrp2: ApiHandler = async ({ pubKey, proof }, ctx) => {
    if (!ctx.session)
        return new ApiError(HTTP_SERVER_ERROR)
    if (!ctx.session.loggingIn)
        return new ApiError(HTTP_CONFLICT)
    const { username, sid } = ctx.session.loggingIn
    delete ctx.session.loggingIn
    const step1 = ongoingLogins[sid]
    if (!step1)
        return new ApiError(HTTP_NOT_FOUND)
    try {
        const M2 = await step1.step2(BigInt(pubKey), BigInt(proof))
        await setLoggedIn(ctx, username)
        return {
            proof: String(M2),
            redirect: ctx.state.account?.redirect,
            ...await refresh_session({},ctx)
        }
    }
    catch(e) {
        ctx.logExtra({ u: username })
        ctx.state.dontLog = false // log even if log_api is false
        events.emit('failedLogin', ctx, { username })
        return new ApiError(HTTP_UNAUTHORIZED, String(e))
    }
    finally {
        delete ongoingLogins[sid]
    }
}

// this api is here for consistency, but frontend is actually using
export const logout: ApiHandler = async ({}, ctx) => {
    if (!ctx.session)
        return new ApiError(HTTP_SERVER_ERROR)
    await setLoggedIn(ctx, false)
    // 401 is a convenient code for OK: the browser clears a possible http authentication (hopefully), and Admin automatically triggers login dialog
    return new ApiError(HTTP_UNAUTHORIZED)
}

export const refresh_session: ApiHandler = async ({}, ctx) => {
    const username = getCurrentUsername(ctx)
    return !ctx.session ? new ApiError(HTTP_SERVER_ERROR) : {
        username,
        expandedUsername: expandUsername(username),
        adminUrl: ctxAdminAccess(ctx) ? ctx.state.revProxyPath + ADMIN_URI : undefined,
        canChangePassword: canChangePassword(ctx.state.account),
        requireChangePassword: ctx.state.account?.require_password_change,
        exp: keepSessionAlive.get() ? new Date(Date.now() + sessionDuration.compiled()) : undefined,
        accountExp: ctx.state.account?.expire,
    }
}

export const change_my_srp: ApiHandler = async ({ salt, verifier }, ctx) => {
    const a = ctx.state.account
    return !a || !canChangePassword(a) ? new ApiError(HTTP_UNAUTHORIZED)
        : changeSrpHelper(a, salt, verifier).then(() => {
            delete a.require_password_change
        })
}

function canChangePassword(account: Account | undefined) {
    return account && !getFromAccount(account, a => a.disable_password_change)
}