// Copyright (c) 2026 LEANEA GmbH and others.
//
// This program and the accompanying materials are made available under the
// terms of the Apache License, Version 2.0 which is available at
// https://www.apache.org/licenses/LICENSE-2.0.
//
// SPDX-License-Identifier: Apache-2.0
//
// Prepared with AI-assisted tools and reviewed by the author.
// Assisted-by: AI
import { createApp, computed, onMounted, onUnmounted, ref } from "vue";
import { api, request } from "./services/api.js";
import { beginLogin, completeLoginFromLocation } from "./services/auth.js";
import { store } from "./state/store.js";
import { runtime, applyPublicConfiguration } from "./config/runtime.js";
import { initializeBridge, bridgePing, onBridgeReconnect } from "./services/transport.js";
import { normalizeUiError } from "./state/reducers.js";
import { UiFeedback, UiProgress, UiField } from "./components/feedback.js";
import "./styles.css";
const App = {
  components: { Sr2Console, UiFeedback, UiProgress, UiField },
  setup() {
    const config = ref(null);
    const registrations = ref([]);
    const tenants = ref([]);
    const members = ref([]);
    const form = ref({
      organizationIdentifier: "",
      organizationName: "",
      contactName: "",
      contactEmail: "",
      requestedSlug: "",
      registrationMode: "public"
    });
    const invite = ref({ username: "", email: "", firstName: "", lastName: "", role: "principal" });
    const submission = ref(null);
    const verification = ref({ state: "idle", message: "" });
    const hashRoute = ref(window.location.hash || "#/register");
    const tenantTheme = computed(() => ({ '--tenant-width': store.tenant?.branding?.layout === 'focused' ? '1040px': '1200px' }));
    const providerTab = ref('applications');
    const isTenantHost = computed(() => Boolean(store.tenant));
    const isProvider = computed(() => hashRoute.value.startsWith("#/provider"));
    const isTenantAdmin = computed(() => store.session?.roles?.includes("participant_tenant_admin"));
    const isProviderAdmin = computed(() => store.session?.roles?.includes("provider_admin"));
    const pending = computed(() => registrations.value.filter((item) => item.state === "pending_approval"));
    function setError(error) {
      store.errors.global = normalizeUiError(error);
    }
    async function loadSession() {
      try {
        store.session = (await api.session()).session;
      } catch (error) {
        if (error.status === 401) store.session = null;
        else setError(error);
      }
    }
    async function loadTenant() {
      try {
        store.tenant = (await api.tenantContext()).tenant;
        try {
          store.tenant.branding = (await request('/api/v1/public/branding')).branding;
        } catch {}
      } catch (error) {
        if (error.status === 404) store.tenant = null;
        else setError(error);
      }
    }
    async function loadProvider() {
      if (isTenantHost.value || !isProviderAdmin.value) return;
      store.busy = true;
      try {
        const [r, t] = await Promise.all([api.registrations(), api.tenants()]);
        registrations.value = r.items;
        tenants.value = t.items;
      } catch (error) {
        setError(error);
      } finally {
        store.busy = false;
      }
    }
    async function loadMembers() {
      if (!store.tenant || !isTenantAdmin.value) return;
      try {
        members.value = (await api.tenantMembers(store.tenant.tenantId)).items;
      } catch (error) {
        setError(error);
      }
    }
    async function submitRegistration() {
      store.busy = true;
      try {
        submission.value = (await api.register(form.value)).registration;
      } catch (error) {
        setError(error);
      } finally {
        store.busy = false;
      }
    }
    async function verifyFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const registrationId = params.get("verify_registration");
      const token = params.get("token");
      if (!registrationId || !token) return;
      verification.value = { state: "working", message: "Verifying the single-use registration link..." };
      try {
        await api.verify(registrationId, token);
        verification.value = { state: "success", message: "Email verified. The registration is waiting for provider approval." };
      } catch (error) {
        verification.value = { state: "failed", message: error.message || "Verification failed." };
      }
    }
    async function decide(item, action) {
      const promptText = action === "approve" ? "Approval note (optional)": "Rejection reason (required)";
      const reason = window.prompt(promptText, action === "approve" ? "Reviewed and approved": "Registration requires correction");
      if (reason === null || (action === "reject" && reason.trim().length < 3)) return;
      try {
        if (action === "approve") await api.approve(item, reason);
        else await api.reject(item, reason);
        await loadProvider();
      } catch (error) {
        setError(error);
      }
    }
    async function inviteMember() {
      if (!store.tenant) return;
      store.busy = true;
      try {
        await api.inviteMember(store.tenant.tenantId, invite.value);
        invite.value = { username: "", email: "", firstName: "", lastName: "", role: "principal" };
        await loadMembers();
      } catch (error) {
        setError(error);
      } finally {
        store.busy = false;
      }
    }
    async function lifecycleTenant(tenant, state) {
      const confirmation = window.prompt('Enter the tenant slug to confirm ' + state + ':');
      if (confirmation === null) return;
      try {
        await request(`/api/v1/provider/tenants/${encodeURIComponent(tenant.tenantId)}/lifecycle`, { method: 'POST', body: JSON.stringify(
          { state, confirmation }) });
        await loadProvider();
      } catch (error) {
        setError(error);
      }
    }
    function focusMain() {
      document.getElementById('main')?.focus();
    }
    async function login(native = false) {
      try {
        await beginLogin(native);
      } catch (error) {
        setError(error);
      }
    }
    async function logout() {
      try {
        await api.logout();
      } finally {
        store.session = null;
        window.location.assign(runtime.uiPath);
      }
    }
    async function recoverWorkspace() {
      await loadSession();
      await loadTenant();
      if (isProvider.value) await loadProvider();
      if (isTenantHost.value) await loadMembers();
    }
    const stopReconnect = onBridgeReconnect(recoverWorkspace);
    onUnmounted(stopReconnect);
    function handleHashRoute() {
      hashRoute.value = window.location.hash || "#/register";
      if (hashRoute.value.startsWith("#/provider") && !isTenantHost.value) void loadProvider();
    }
    onUnmounted(() => window.removeEventListener("hashchange", handleHashRoute));
    onMounted(async() => {
      window.addEventListener("hashchange", handleHashRoute);
      try {
        config.value = await api.registrationConfig();
        applyPublicConfiguration(config.value);
        form.value.registrationMode = config.value.registrationMode;
        await completeLoginFromLocation();
        initializeBridge();
        await bridgePing();
      } catch (error) {
        setError(error);
        return;
      }
      await Promise.all([loadSession(), loadTenant()]);
      await verifyFromUrl();
      if (isProvider.value && !isTenantHost.value) await loadProvider();
      if (isTenantHost.value) await loadMembers();
      try {
        store.platform = await api.platformStatus();
      } catch {
        /* platform endpoint may be warming up */
      }
    });
    return {
      tenantTheme,
      providerTab,
      recoverWorkspace,
      focusMain,
      store,
      runtime,
      config,
      registrations,
      tenants,
      members,
      form,
      invite,
      submission,
      verification,
      hashRoute,
      isTenantHost,
      isProvider,
      isTenantAdmin,
      isProviderAdmin,
      pending,
      submitRegistration,
      decide,
      inviteMember,
      login,
      logout,
      lifecycleTenant,
      loadProvider,
      loadMembers,
    };
  },
  template: [
    "\n<div class=\"app-shell\">\n  <a class=\"skip-link\" href=\"#main\" @click.prevent=\"focusMain\">Skip",
    " to main content</a>\n  <header class=\"topbar\">\n    <a class=\"brand\" :href=\"runtime.uiPath\" ari",
    "a-label=\"FACIS FAP PCI home\">\n      <img class=\"brand-logo\" :src=\"runtime.uiPath+'facis-logo.svg",
    "'\" width=\"106\" height=\"40\" alt=\"FACIS\">\n      <span>\n        <strong>FAP PCI</strong>\n      ",
    "  <small>Principal Credential Issuance</small>\n      </span>\n    </a>\n    <nav aria-label=\"Primary",
    "\">\n      <a v-if=\"!isTenantHost\" href=\"#/register\">Registration</a>\n      <a v-if=\"!isTenantHo",
    "st\" href=\"#/provider\">Provider review</a>\n      <button v-if=\"!store.session\" class=\"link-butto",
    "n\" @click=\"login\">Sign in</button>\n      <button v-else class=\"link-button\" @click=\"logout\">Si",
    "gn out</button>\n    </nav>\n  </header>\n  <main id=\"main\" tabindex=\"-1\">\n    <ui-feedback\n    ",
    "  class=\"global-error\"\n      :error=\"store.errors.global\"\n      @dismiss=\"store.errors.global=n",
    "ull\"\n      @recover=\"recoverWorkspace\"\n    />\n    <p v-if=\"!store.live.connected\" class=\"conn",
    "ection-status\" role=\"status\">Connecting to your workspace…</p>\n    <ui-progress />\n    <section v",
    "-if=\"verification.state !== 'idle'\" class=\"center-card card\" aria-live=\"polite\">\n      <span cl",
    "ass=\"status-icon\" :class=\"verification.state\">{{ verification.state === 'working' ? '...' : verifi",
    "cation.state === 'success' ? 'OK' : '!' }}</span>\n      <p class=\"eyebrow\">EMAIL VERIFICATION</p>\n",
    "      <h1>\n        {{ verification.state === 'success' ? 'Registration verified' : verification.state",
    " === 'failed' ? 'Verification failed' : 'Checking link' }}\n      </h1>\n      <p>{{ verification.mess",
    "age }}</p>\n      <a class=\"button-link secondary\" :href=\"runtime.uiPath\">Return to registration</",
    "a>\n    </section>\n    <section\n      v-else-if=\"isTenantHost\"\n      class=\"tenant-landing\"\n  ",
    "    :class=\"{'tenant-workspace':store.session && store.tenant.state==='active'}\"\n      :style=\"ten",
    "antTheme\"\n    >\n      <div class=\"tenant-welcome\" v-if=\"!store.session || store.tenant.state!=='",
    "active'\">\n        <div class=\"tenant-guidance\">\n          <p class=\"eyebrow\">PARTICIPANT PORTAL",
    "</p>\n          <img\n            v-if=\"store.tenant.branding?.logoAssetId\"\n            class=\"ten",
    "ant-logo\"\n            :src=\"runtime.basePath+'/api/v1/public/assets/'+store.tenant.branding.logoAss",
    "etId\"\n            alt=\"Organization logo\"\n          >\n          <h1>{{ store.tenant.branding?.ti",
    "tle || store.tenant.organizationName }}</h1>\n          <p class=\"lead\">{{store.tenant.branding?.des",
    "cription || 'Sign in to manage or request organization credentials.'}}</p>\n        </div>\n        <d",
    "iv class=\"tenant-summary card dark-card\">\n          <span class=\"badge\" :class=\"'badge-' + store",
    ".tenant?.state\">{{ store.tenant?.state }}</span>\n          <code>{{ store.tenant?.primaryDomain }}</",
    "code>\n          <p v-if=\"!store.session\">Authentication is required before participant or principal",
    " functions are available.</p>\n          <button v-if=\"!store.session\" @click=\"login\">Sign in to y",
    "our organization</button>\n          <button v-if=\"!store.session\" class=\"secondary\" @click=\"logi",
    "n(true)\">Tenant administrator sign in</button>\n          <div v-else class=\"profile-box\">\n       ",
    "     <strong>{{ store.session.displayName || store.session.username }}</strong>\n            <span>{{ ",
    "store.session.email }}</span>\n            <div class=\"role-list\">\n              <span v-for=\"role",
    " in store.session.roles\" :key=\"role\" class=\"badge\">{{ role }}</span>\n            </div>\n       ",
    "   </div>\n        </div>\n      </div>\n      <sr2-console\n        v-if=\"store.session && store.ten",
    "ant.state==='active'\"\n        :tenant=\"store.tenant\"\n        :session=\"store.session\"\n      >",
    "\n        <template #members>\n          <section v-if=\"isTenantAdmin\" class=\"card member-admin\">",
    "\n            <h2>Tenant members</h2>\n            <p>Invite organization members, then grant issuer a",
    "ccess below.</p>\n            <form class=\"member-form\" @submit.prevent=\"inviteMember\">\n         ",
    "     <input aria-label=\"Username\" v-model=\"invite.username\" required placeholder=\"Username\" />\n",
    "              <input aria-label=\"Email\" v-model=\"invite.email\" required type=\"email\" placeholder",
    "=\"Email\" />\n              <input aria-label=\"First name\" v-model=\"invite.firstName\" required pl",
    "aceholder=\"First name\" />\n              <input aria-label=\"Last name\" v-model=\"invite.lastName\"",
    " required placeholder=\"Last name\" />\n              <select aria-label=\"Member role\" v-model=\"inv",
    "ite.role\">\n                <option value=\"principal\">Principal</option>\n                <option v",
    "alue=\"issuer_admin\">Issuer administrator</option>\n                <option value=\"participant_tenan",
    "t_admin\">Tenant administrator</option>\n              </select>\n              <button :disabled=\"st",
    "ore.busy\">Invite</button>\n            </form>\n            <div class=\"table-wrap\">\n             ",
    " <table>\n                <thead>\n                  <tr>\n                    <th>User</th>\n        ",
    "            <th>Email</th>\n                    <th>Roles</th>\n                    <th>Status</th>\n ",
    "                 </tr>\n                </thead>\n                <tbody>\n                  <tr v-for",
    "=\"member in members\" :key=\"member.subject\">\n                    <td>{{ member.username }}</td>\n ",
    "                   <td>{{ member.email }}</td>\n                    <td>{{ member.roles.join(', ') }}<",
    "/td>\n                    <td>{{ member.enabled ? 'Enabled' : 'Disabled' }}</td>\n                  </",
    "tr>\n                </tbody>\n              </table>\n            </div>\n          </section>\n     ",
    "   </template>\n      </sr2-console>\n      <footer v-if=\"store.tenant.branding?.footer\" class=\"ten",
    "ant-footer preserve-lines\">{{store.tenant.branding.footer}}</footer>\n    </section>\n    <section v-",
    "else-if=\"isProvider\" class=\"console-page\">\n      <aside class=\"provider-guidance\">\n        <p ",
    "class=\"eyebrow\">PROVIDER WORKSPACE</p>\n        <h2>Participant organizations</h2>\n        <p>Revie",
    "w applications, then follow each organization’s setup.</p>\n        <nav aria-label=\"Provider tasks\"",
    ">\n          <button\n            class=\"secondary\"\n            :aria-pressed=\"providerTab==='appl",
    "ications'\"\n            @click=\"providerTab='applications'\"\n          >Applications</button>\n    ",
    "      <button class=\"secondary\" :aria-pressed=\"providerTab==='tenants'\" @click=\"providerTab='tena",
    "nts'\">Tenant availability</button>\n        </nav>\n      </aside>\n      <div class=\"provider-conte",
    "nt\">\n        <div class=\"console-header\">\n          <div>\n            <p class=\"eyebrow\">PROVI",
    "DER ADMINISTRATION</p>\n            <h1>{{providerTab==='applications'?'Registration review queue':'Te",
    "nant availability'}}</h1>\n            <p>Review verified applications and manage participant organiza",
    "tions.</p>\n          </div>\n          <div class=\"auth-panel\">\n            <template v-if=\"!stor",
    "e.session\">\n              <button @click=\"login\">Sign in to your organization</button>\n          ",
    "  </template>\n            <template v-else>\n              <strong>{{ store.session.displayName || st",
    "ore.session.username }}</strong>\n              <span>{{ store.session.roles.join(', ') }}</span>\n   ",
    "           <button class=\"secondary\" @click=\"loadProvider\">Refresh</button>\n            </templat",
    "e>\n          </div>\n        </div>\n        <div v-if=\"store.session && !isProviderAdmin\" class=\"",
    "error\">Your Keycloak account does not have the provider_admin role.</div>\n        <template v-if=\"i",
    "sProviderAdmin\">\n          <section class=\"stats\">\n            <div class=\"stat orange\">\n     ",
    "         <strong>{{ pending.length }}</strong>\n              <span>Pending approval</span>\n         ",
    "   </div>\n            <div class=\"stat\">\n              <strong>{{ registrations.filter(x => x.stat",
    "e === 'approved').length }}</strong>\n              <span>Approved</span>\n            </div>\n       ",
    "     <div class=\"stat purple\">\n              <strong>{{ registrations.filter(x => x.state === 'reje",
    "cted').length }}</strong>\n              <span>Rejected</span>\n            </div>\n            <div c",
    "lass=\"stat green\">\n              <strong>{{ tenants.filter(x => x.state === 'active').length }}</st",
    "rong>\n              <span>Active tenants</span>\n            </div>\n          </section>\n          ",
    "<section v-if=\"providerTab==='applications'\" class=\"card table-card\">\n            <div class=\"se",
    "ction-title\">\n              <div>\n                <h2>Applications</h2>\n                <p>Email v",
    "erification remains distinct from provider approval.</p>\n              </div>\n              <button ",
    "class=\"secondary compact\" @click=\"loadProvider\">Refresh</button>\n            </div>\n            ",
    "<div class=\"table-wrap\">\n              <table>\n                <thead>\n                  <tr>\n  ",
    "                  <th>Organization</th>\n                    <th>Requested host</th>\n                ",
    "    <th>Contact</th>\n                    <th>Status</th>\n                    <th>Action</th>\n      ",
    "            </tr>\n                </thead>\n                <tbody>\n                  <tr v-for=\"it",
    "em in registrations\" :key=\"item.registrationId\">\n                    <td>\n                      <",
    "strong>{{ item.organizationName }}</strong>\n                      <small>{{ item.organizationIdentifi",
    "er }}</small>\n                    </td>\n                    <td>\n                      <code>{{ ite",
    "m.requestedDomain }}</code>\n                    </td>\n                    <td>\n                    ",
    "  {{ item.contactName }}\n                      <small>{{ item.contactEmail }}</small>\n              ",
    "      </td>\n                    <td>\n                      <span class=\"badge\" :class=\"'badge-' +",
    " item.state.replace('_','-')\">{{ item.state }}</span>\n                    </td>\n                   ",
    " <td>\n                      <div v-if=\"item.state === 'pending_approval'\" class=\"actions\">\n     ",
    "                   <button class=\"compact\" @click=\"decide(item, 'approve')\">Approve</button>\n    ",
    "                    <button class=\"compact danger\" @click=\"decide(item, 'reject')\">Reject</button>",
    "\n                      </div>\n                    </td>\n                  </tr>\n                  ",
    "<tr v-if=\"!registrations.length\">\n                    <td colspan=\"5\" class=\"empty\">No registra",
    "tions.</td>\n                  </tr>\n                </tbody>\n              </table>\n            </",
    "div>\n          </section>\n          <section v-if=\"providerTab==='tenants'\" class=\"card table-car",
    "d\">\n            <div class=\"section-title\">\n              <div>\n                <h2>Tenant recon",
    "ciliation</h2>\n                <p>Track organization setup and availability.</p>\n              </div",
    ">\n            </div>\n            <div class=\"tenant-grid\">\n              <article v-for=\"tenant ",
    "in tenants\" :key=\"tenant.tenantId\" class=\"tenant-card\">\n                <div class=\"tenant-card",
    "-head\">\n                  <h3>{{ tenant.organizationName }}</h3>\n                  <span class=\"ba",
    "dge\" :class=\"'badge-' + tenant.state\">{{ tenant.state }}</span>\n                </div>\n          ",
    "      <code>{{ tenant.primaryDomain }}</code>\n                <p>Generation {{ tenant.observedGenerat",
    "ion }} / {{ tenant.desiredGeneration }}</p>\n                <ul>\n                  <li v-for=\"condi",
    "tion in tenant.conditions\" :key=\"condition.type\">\n                    <span>{{ condition.type }}</",
    "span>\n                    <strong>{{ condition.status }}</strong>\n                  </li>\n         ",
    "       </ul>\n                <div class=\"actions\">\n                  <button\n                    ",
    "v-if=\"tenant.state==='active'\"\n                    class=\"secondary\"\n                    @click=",
    "\"lifecycleTenant(tenant,'suspended')\"\n                  >Suspend</button>\n                  <butto",
    "n v-if=\"tenant.state==='suspended'\" @click=\"lifecycleTenant(tenant,'provisioning')\">Resume</button",
    ">\n                  <button\n                    v-if=\"!['deleted','deleting'].includes(tenant.state",
    ")\"\n                    class=\"danger\"\n                    @click=\"lifecycleTenant(tenant,'deleti",
    "ng')\"\n                  >Delete tenant</button>\n                </div>\n              </article>\n ",
    "           </div>\n          </section>\n        </template>\n      </div>\n    </section>\n    <secti",
    "on v-else class=\"page-grid\">\n      <div class=\"hero-panel\">\n        <p class=\"eyebrow\">TENANT ",
    "FOUNDATION</p>\n        <h1>Register a participant organization</h1>\n        <p class=\"lead\">\n    ",
    "      Submit organization details. Verify your email and submit your organization for provider review.",
    "\n          We’ll prepare your workspace after approval.\n        </p>\n        <ol class=\"steps\">\n",
    "          <li>\n            <span>1</span>\n            Submit\n          </li>\n          <li>\n     ",
    "       <span>2</span>\n            Verify email\n          </li>\n          <li>\n            <span>3<",
    "/span>\n            Provider review\n          </li>\n          <li>\n            <span>4</span>\n    ",
    "        Provision\n          </li>\n        </ol>\n      </div>\n      <div class=\"card form-card\">",
    "\n        <div v-if=\"submission\" class=\"success\">\n          <span class=\"status-icon success\">O",
    "K</span>\n          <h2>Registration received</h2>\n          <p>A single-use verification link was se",
    "nt through the configured SMTP service.</p>\n          <dl>\n            <div>\n              <dt>Requ",
    "ested host</dt>\n              <dd>{{ submission.requestedDomain }}</dd>\n            </div>\n        ",
    "    <div>\n              <dt>Email delivery</dt>\n              <dd>{{ submission.emailDeliveryStatus ",
    "}}</dd>\n            </div>\n          </dl>\n          <button class=\"secondary\" @click=\"submissio",
    "n = null\">Register another</button>\n        </div>\n        <form v-else @submit.prevent=\"submitReg",
    "istration\">\n          <h2>Organization registration</h2>\n          <ui-field\n            label=\"O",
    "rganization identifier\"\n            name=\"organizationIdentifier\"\n            v-model=\"form.orga",
    "nizationIdentifier\"\n            :error=\"store.errors.global?.fields?.organizationIdentifier\"\n    ",
    "        required\n            placeholder=\"urn:example:alpha\"\n          />\n          <ui-field\n  ",
    "          label=\"Organization name\"\n            name=\"organizationName\"\n            v-model=\"fo",
    "rm.organizationName\"\n            :error=\"store.errors.global?.fields?.organizationName\"\n         ",
    "   required\n            placeholder=\"Alpha GmbH\"\n          />\n          <div class=\"two-column\"",
    ">\n            <ui-field\n              label=\"Contact name\"\n              name=\"contactName\"\n  ",
    "            v-model=\"form.contactName\"\n              :error=\"store.errors.global?.fields?.contactN",
    "ame\"\n              required\n              placeholder=\"Alex Admin\"\n            />\n            <",
    "ui-field\n              label=\"Contact email\"\n              name=\"contactEmail\"\n              v-",
    "model=\"form.contactEmail\"\n              :error=\"store.errors.global?.fields?.contactEmail\"\n     ",
    "         required\n              placeholder=\"admin@alpha.example\"\n              type=\"email\"\n  ",
    "          />\n          </div>\n          <ui-field\n            label=\"Tenant slug\"\n            na",
    "me=\"requestedSlug\"\n            v-model=\"form.requestedSlug\"\n            :error=\"store.errors.gl",
    "obal?.fields?.requestedSlug\"\n            required\n            pattern=\"[a-z0-9](?:[a-z0-9-]{0,38}[",
    "a-z0-9])?\"\n            placeholder=\"alpha\"\n          >\n            <small>\n              Create",
    "s {{ form.requestedSlug || '{slug}' }}-{{ config?.hostnameTemplate?.split('-').slice(1).join('-') || '",
    "pci.example.com' }}\n            </small>\n          </ui-field>\n          <label class=\"consent\">",
    "\n            <input required type=\"checkbox\" />\n            <span>I confirm the information may be",
    " processed for tenant onboarding and provider review.</span>\n          </label>\n          <button :d",
    "isabled=\"store.busy\">{{ store.busy ? 'Submitting...' : 'Submit registration' }}</button>\n        </",
    "form>\n      </div>\n    </section>\n  </main>\n  <footer>\n    <span>FACIS.FAP_PCI</span>\n    <span>",
    "Credential workspace · __FAP_PCI_VERSION__</span>\n  </footer>\n</div>\n"
  ].join('')
};
createApp(App).mount("#app");
