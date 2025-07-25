import $ from "jquery";
import * as z from "zod/mini";

import * as about_zulip from "./about_zulip.ts";
import * as admin from "./admin.ts";
import * as blueslip from "./blueslip.ts";
import * as browser_history from "./browser_history.ts";
import * as drafts_overlay_ui from "./drafts_overlay_ui.ts";
import {Filter} from "./filter.ts";
import * as hash_parser from "./hash_parser.ts";
import * as hash_util from "./hash_util.ts";
import {$t_html} from "./i18n.ts";
import * as inbox_ui from "./inbox_ui.ts";
import * as info_overlay from "./info_overlay.ts";
import * as message_fetch from "./message_fetch.ts";
import * as message_view from "./message_view.ts";
import * as message_viewport from "./message_viewport.ts";
import * as modals from "./modals.ts";
import * as overlays from "./overlays.ts";
import {page_params} from "./page_params.ts";
import * as people from "./people.ts";
import * as popovers from "./popovers.ts";
import * as recent_view_ui from "./recent_view_ui.ts";
import * as reminders_overlay_ui from "./reminders_overlay_ui.ts";
import * as scheduled_messages_overlay_ui from "./scheduled_messages_overlay_ui.ts";
import * as settings from "./settings.ts";
import * as settings_panel_menu from "./settings_panel_menu.ts";
import * as settings_toggle from "./settings_toggle.ts";
import * as sidebar_ui from "./sidebar_ui.ts";
import * as spectators from "./spectators.ts";
import {current_user} from "./state_data.ts";
import * as stream_settings_ui from "./stream_settings_ui.ts";
import * as ui_report from "./ui_report.ts";
import * as user_group_edit from "./user_group_edit.ts";
import * as user_profile from "./user_profile.ts";
import {user_settings} from "./user_settings.ts";

// Read https://zulip.readthedocs.io/en/latest/subsystems/hashchange-system.html
// or locally: docs/subsystems/hashchange-system.md

export type JQueryHashChangeEvent<TDelegateTarget, TData, TCurrentTarget, TTarget> =
    JQuery.EventBase<TDelegateTarget, TData, TCurrentTarget, TTarget> & {
        type: "hashchanged";
        originalEvent: HashChangeEvent;
    };

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace JQuery {
        // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
        interface TypeToTriggeredEventMap<TDelegateTarget, TData, TCurrentTarget, TTarget> {
            hashchange: JQueryHashChangeEvent<TDelegateTarget, TData, TCurrentTarget, TTarget>;
        }
    }
}

function show_all_message_view(): void {
    // Don't export this function outside of this module since
    // `change_hash` is false here which means it is should only
    // be called after hash is updated in the URL.
    const current_state = z.nullable(browser_history.state_data_schema).parse(window.history.state);
    message_view.show([{operator: "in", operand: "home"}], {
        trigger: "hashchange",
        change_hash: false,
        then_select_id: current_state?.narrow_pointer,
        then_select_offset: current_state?.narrow_offset,
    });
}

function is_somebody_else_profile_open(): boolean {
    return (
        user_profile.get_user_id_if_user_profile_modal_open() !== undefined &&
        user_profile.get_user_id_if_user_profile_modal_open() !== people.my_current_user_id()
    );
}

function handle_invalid_users_section_url(user_settings_tab: string): string {
    const valid_user_settings_tab_values = new Set(["active", "deactivated", "invitations"]);
    if (!valid_user_settings_tab_values.has(user_settings_tab)) {
        const valid_users_section_url = "#organization/users/active";
        browser_history.update(valid_users_section_url);
        return "active";
    }
    return user_settings_tab;
}

function get_user_settings_tab(section: string): string | undefined {
    if (section === "users") {
        const current_user_settings_tab = hash_parser.get_current_nth_hash_section(2);
        return handle_invalid_users_section_url(current_user_settings_tab);
    }
    return undefined;
}

export function set_hash_to_home_view(triggered_by_escape_key = false): void {
    if (browser_history.is_current_hash_home_view()) {
        return;
    }

    const hash_before_current = browser_history.old_hash();
    if (
        triggered_by_escape_key &&
        browser_history.get_home_view_hash() === "#feed" &&
        (hash_before_current === "" || hash_before_current === "#feed")
    ) {
        // If the previous view was the user's Combined Feed home
        // view, and this change was triggered by escape keypress,
        // then we simulate the back button in order to reuse
        // existing code for restoring the user's scroll position.
        window.history.back();
        return;
    }

    // We want to set URL with no hash here. It is not possible
    // to do so with `window.location.hash` since it will set an empty
    // hash. So, we use `pushState` which simply updates the current URL
    // but doesn't trigger `hashchange`. So, we trigger hashchange directly
    // here to let it handle the whole rendering process for us.
    browser_history.set_hash("");
    hashchanged(false);
}

function show_home_view(): void {
    // This function should only be called from the hashchange
    // handlers, as it does not set the hash to "".
    //
    // We only allow the primary recommended options for home views
    // rendered without a hash.
    switch (user_settings.web_home_view) {
        case "recent_topics": {
            recent_view_ui.show();
            break;
        }
        case "all_messages": {
            // Hides inbox/recent views internally if open.
            show_all_message_view();
            break;
        }
        case "inbox": {
            inbox_ui.show();
            break;
        }
        default: {
            // NOTE: Setting a hash which is not rendered on
            // empty hash (like a stream narrow) will
            // introduce a bug that user will not be able to
            // go back in browser history. See
            // https://chat.zulip.org/#narrow/channel/9-issues/topic/Browser.20back.20button.20on.20RT
            // for detailed description of the issue.
            window.location.hash = user_settings.web_home_view;
        }
    }
}

// Returns true if this function performed a narrow
function do_hashchange_normal(from_reload: boolean, restore_selected_id: boolean): boolean {
    message_viewport.stop_auto_scrolling();

    // NB: In Firefox, window.location.hash is URI-decoded.
    // Even if the URL bar says #%41%42%43%44, the value here will
    // be #ABCD.
    const hash = window.location.hash.split("/");

    switch (hash[0]) {
        case "#topics":
        case "#narrow": {
            let terms;
            try {
                // TODO: Show possible valid URLs to the user.
                terms = hash_util.parse_narrow(hash);
            } catch {
                ui_report.error(
                    $t_html({defaultMessage: "Invalid URL"}),
                    undefined,
                    $("#home-error"),
                    2000,
                );
            }
            if (terms === undefined) {
                // If the narrow URL didn't parse,
                // send them to web_home_view.
                // We cannot clear hash here since
                // it will block user from going back
                // in browser history.
                show_home_view();
                return false;
            }

            // Show inbox style topics list for #topics narrow.
            if (hash[0] === "#topics" && terms.length === 1) {
                const channel_id_string = hash[2];
                if (channel_id_string) {
                    inbox_ui.show(new Filter(terms));
                    return true;
                }
            }

            const narrow_opts: message_view.ShowMessageViewOpts = {
                change_hash: false, // already set
                trigger: "hash change",
                show_more_topics: false,
            };
            if (from_reload) {
                blueslip.debug("We are narrowing as part of a reload.");
                if (message_fetch.initial_narrow_pointer !== undefined) {
                    narrow_opts.then_select_id = message_fetch.initial_narrow_pointer;
                    narrow_opts.then_select_offset = message_fetch.initial_narrow_offset;
                }
            }

            const data_for_hash = z
                .nullable(browser_history.state_data_schema)
                .parse(window.history.state);
            if (restore_selected_id && data_for_hash) {
                narrow_opts.then_select_id = data_for_hash.narrow_pointer;
                narrow_opts.then_select_offset = data_for_hash.narrow_offset;
                narrow_opts.show_more_topics = data_for_hash.show_more_topics ?? false;
            }
            message_view.show(terms, narrow_opts);
            return true;
        }
        case "":
        case "#":
            show_home_view();
            break;
        case "#recent_topics":
            // The URL for Recent Conversations was changed from
            // #recent_topics to #recent in 2022. Because pre-change
            // Welcome Bot messages included links to this URL, we
            // need to support the "#recent_topics" hash as an alias
            // for #recent permanently. We show the view and then
            // replace the current URL hash in a way designed to hide
            // this detail in the browser's forward/back session history.
            recent_view_ui.show();
            window.location.replace("#recent");
            break;
        case "#recent":
            recent_view_ui.show();
            break;
        case "#inbox":
            inbox_ui.show();
            break;
        case "#all_messages":
            // "#all_messages" was renamed to "#feed" in 2024. Unlike
            // the recent hash rename, there are likely few links that
            // would break if this compatibility code was removed, but
            // there's little cost to keeping it.
            show_all_message_view();
            window.location.replace("#feed");
            break;
        case "#feed":
            show_all_message_view();
            break;
        case "#keyboard-shortcuts":
        case "#message-formatting":
        case "#search-operators":
        case "#drafts":
        case "#invite":
        case "#channels":
        case "#streams":
        case "#organization":
        case "#settings":
        case "#about-zulip":
        case "#scheduled":
        case "#reminders":
            blueslip.error("overlay logic skipped for: " + hash[0]);
            break;
        default:
            show_home_view();
    }
    return false;
}

function do_hashchange_overlay(old_hash: string | undefined): void {
    if (old_hash === undefined) {
        // The user opened the app with an overlay hash; we need to
        // show the user's home view behind it.
        show_home_view();
    }
    let base = hash_parser.get_current_hash_category();
    const old_base = hash_parser.get_hash_category(old_hash);
    let section = hash_parser.get_current_hash_section();

    if (base === "groups" && current_user.is_guest) {
        // The #groups settings page is unfinished, and disabled in production.
        show_home_view();
        return;
    }

    const coming_from_overlay = hash_parser.is_overlay_hash(old_hash);
    if (section === "display-settings") {
        // Since display-settings was deprecated and replaced with preferences
        // #settings/display-settings is being redirected to #settings/preferences.
        section = "preferences";
    }
    if (section === "user-list-admin") {
        // #settings/user-list-admin is being redirected to #settings/users after it was renamed.
        section = "users";
    }
    if ((base === "settings" || base === "organization") && !section) {
        let settings_panel_object = settings_panel_menu.normal_settings;
        if (base === "organization") {
            settings_panel_object = settings_panel_menu.org_settings;
        }
        window.history.replaceState(
            null,
            "",
            browser_history.get_full_url(base + "/" + settings_panel_object.current_tab),
        );
    }

    // In 2024, stream was renamed to channel in the Zulip API and UI.
    // Because pre-change Welcome Bot and Notification Bot messages
    // included links to "/#streams/all" and "/#streams/new", we'll
    // need to support "streams" as an overlay hash as an alias for
    // "channels" permanently.
    if (base === "streams" || base === "channels") {
        const valid_hash = hash_util.validate_channels_settings_hash(window.location.hash);
        // Here valid_hash will always return "channels" as the base.
        // So, if we update the history because the valid hash does
        // not match the window.location.hash, then we also reset the
        // base string we're tracking for the hash.
        if (valid_hash !== window.location.hash) {
            window.history.replaceState(null, "", browser_history.get_full_url(valid_hash));
            section = hash_parser.get_current_hash_section();
            base = hash_parser.get_current_hash_category();
        }
    }

    if (base === "groups") {
        const valid_hash = hash_util.validate_group_settings_hash(window.location.hash);
        if (valid_hash !== window.location.hash) {
            window.history.replaceState(null, "", browser_history.get_full_url(valid_hash));
            section = hash_parser.get_current_hash_section();
        }
    }

    // Start by handling the specific case of going from
    // something like "#channels/all" to "#channels/subscribed".
    //
    // In most situations we skip by this logic and load
    // the new overlay.
    if (coming_from_overlay && base === old_base) {
        if (base === "channels") {
            if (hash_parser.get_current_nth_hash_section(1) === "folders") {
                const folder_id = hash_parser.get_current_nth_hash_section(2);
                stream_settings_ui.change_state(
                    "new",
                    undefined,
                    "",
                    Number.parseInt(folder_id, 10),
                );
                return;
            }

            // e.g. #channels/29/social/subscribers
            const right_side_tab = hash_parser.get_current_nth_hash_section(3);
            stream_settings_ui.change_state(section, undefined, right_side_tab);
            return;
        }

        if (base === "groups") {
            const right_side_tab = hash_parser.get_current_nth_hash_section(3);
            user_group_edit.change_state(section, undefined, right_side_tab);
        }

        if (base === "settings") {
            if (!section) {
                // We may be on a really old browser or somebody
                // hand-typed a hash.
                blueslip.warn("missing section for settings");
            }
            settings_panel_menu.normal_settings.activate_section_or_default(section);
            return;
        }

        if (base === "organization") {
            if (!section) {
                // We may be on a really old browser or somebody
                // hand-typed a hash.
                blueslip.warn("missing section for organization");
            }
            settings_panel_menu.org_settings.activate_section_or_default(
                section,
                get_user_settings_tab(section),
            );
            return;
        }

        // TODO: handle other cases like internal settings
        //       changes.
        return;
    }

    // This is a special case when user clicks on a URL that makes the overlay switch
    // from org settings to user settings or user edits the URL to switch between them.
    const settings_hashes = new Set(["settings", "organization"]);
    // Ensure that we are just switching between user and org settings and the settings
    // overlay is open.
    const is_hashchange_internal =
        settings_hashes.has(base) && settings_hashes.has(old_base) && overlays.settings_open();
    if (is_hashchange_internal) {
        if (base === "settings") {
            settings_panel_menu.normal_settings.set_current_tab(section);
        } else {
            settings_panel_menu.org_settings.set_current_tab(section);
            settings_panel_menu.org_settings.set_user_settings_tab(get_user_settings_tab(section));
        }
        settings_toggle.goto(base);
        return;
    }

    // It's not super likely that an overlay is already open,
    // but you can jump from /settings to /streams by using
    // the browser's history menu or hand-editing the URL or
    // whatever.  If so, just close the overlays.
    if (base !== old_base) {
        overlays.close_for_hash_change();
    }

    // NORMAL FLOW: basically, launch the overlay:

    if (!coming_from_overlay) {
        browser_history.set_hash_before_overlay(old_hash);
    }

    if (base === "channels") {
        if (hash_parser.get_current_nth_hash_section(1) === "folders") {
            const folder_id = hash_parser.get_current_nth_hash_section(2);
            stream_settings_ui.launch("new", undefined, "", Number.parseInt(folder_id, 10));
            return;
        }

        // e.g. #channels/29/social/subscribers
        const right_side_tab = hash_parser.get_current_nth_hash_section(3);

        if (is_somebody_else_profile_open()) {
            stream_settings_ui.launch(section, "all-streams", right_side_tab);
            return;
        }

        // We pass left_side_tab as undefined in change_state to
        // select the tab based on user's subscriptions. "Subscribed" is
        // selected if user is subscribed to the stream being edited.
        // Otherwise "All streams" is selected.
        stream_settings_ui.launch(section, undefined, right_side_tab);
        return;
    }

    if (base === "groups") {
        const right_side_tab = hash_parser.get_current_nth_hash_section(3);

        if (is_somebody_else_profile_open()) {
            user_group_edit.launch(section, "all-groups", right_side_tab);
            return;
        }

        // We pass left_side_tab as undefined in change_state to
        // select the tab based on user's membership. "My groups" is
        // selected if user is a member of group being edited.
        // Otherwise "All groups" is selected.
        user_group_edit.launch(section, undefined, right_side_tab);
        return;
    }

    if (base === "drafts") {
        drafts_overlay_ui.launch();
        return;
    }

    if (base === "settings") {
        settings.build_page();
        admin.build_page();
        settings.launch(section);
        return;
    }

    if (base === "organization") {
        settings.build_page();
        admin.build_page();
        admin.launch(section, get_user_settings_tab(section));
        return;
    }

    if (base === "keyboard-shortcuts") {
        info_overlay.show("keyboard-shortcuts");
        return;
    }

    if (base === "message-formatting") {
        info_overlay.show("message-formatting");
        return;
    }

    if (base === "search-operators") {
        info_overlay.show("search-operators");
        return;
    }

    if (base === "about-zulip") {
        about_zulip.launch();
        return;
    }

    if (base === "scheduled") {
        scheduled_messages_overlay_ui.launch();
        return;
    }

    if (base === "reminders") {
        reminders_overlay_ui.launch();
        return;
    }

    if (base === "user") {
        const user_id = Number.parseInt(hash_parser.get_current_hash_section(), 10);
        if (!people.is_known_user_id(user_id)) {
            user_profile.show_user_profile_access_error_modal();
        } else {
            const user = people.get_by_user_id(user_id);
            user_profile.show_user_profile(user);
        }
        return;
    }
}

function hashchanged(
    from_reload: boolean,
    e?: JQuery.Event | HashChangeEvent,
    restore_selected_id = true,
): boolean | undefined {
    const current_hash = window.location.hash;
    const old_hash = e && ("oldURL" in e ? new URL(e.oldURL).hash : browser_history.old_hash());
    const is_hash_web_public_compatible = browser_history.update_web_public_hash(current_hash);

    const was_internal_change = browser_history.save_old_hash();
    if (was_internal_change) {
        return undefined;
    }

    // TODO: Migrate the `#reload` syntax to use slashes as separators
    // so that this can be part of the main switch statement.
    if (window.location.hash.startsWith("#reload")) {
        // We don't want to change narrow if app is undergoing reload.
        return undefined;
    }

    if (page_params.is_spectator && !is_hash_web_public_compatible) {
        spectators.login_to_access();
        return undefined;
    }

    popovers.hide_all();

    if (hash_parser.is_overlay_hash(current_hash)) {
        browser_history.state.changing_hash = true;
        modals.close_active_if_any();
        do_hashchange_overlay(old_hash);
        browser_history.state.changing_hash = false;
        return undefined;
    }

    // We are changing to a "main screen" view.
    overlays.close_for_hash_change();
    sidebar_ui.hide_all();
    modals.close_active_if_any();
    browser_history.state.changing_hash = true;
    const ret = do_hashchange_normal(from_reload, restore_selected_id);
    browser_history.state.changing_hash = false;
    return ret;
}

export function initialize(): void {
    // We don't want browser to restore the scroll
    // position of the new hash in the current hash.
    window.history.scrollRestoration = "manual";

    $(window).on("hashchange", (e) => {
        hashchanged(false, e.originalEvent);
    });
    hashchanged(true);

    $("body").on("click", "a", function (this: HTMLAnchorElement, e: JQuery.ClickEvent) {
        if (this.hash === window.location.hash && this.hash.includes("/near/")) {
            // User clicked on a link, perhaps a "said" reference, that
            // matches the current view. Such a click doesn't trigger
            // a hashchange event, so we manually trigger one in order
            // to ensure the app scrolls to the correct message.
            hashchanged(false, e, false);
        }
    });
}
