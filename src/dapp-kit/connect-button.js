import { CoreClient } from '@mysten/sui/client';
import {
  getWallets,
  signAndExecuteTransaction as walletStandardSignAndExecuteTransaction,
  signTransaction as walletStandardSignTransaction,
} from '@mysten/wallet-standard';
import { getSuiRpcUrl } from '../utils/settings.js';
import { updateWalletBridgeState } from './wallet-state.js';

const SUI_MAINNET_CHAIN = 'sui:mainnet';
const PREFERRED_WALLET_KEY = 'walrus-pages.preferred-wallet';

const walletsApi = getWallets();

let buttonEl = null;
let pickerEl = null;
let walletListEl = null;
let disconnectEl = null;
let mountedContainer = null;

let selectedWallet = null;
let selectedAccount = null;
let isConnecting = false;
let walletEventsUnsubscribe = null;

function getWalletIdentifier(wallet) {
  return wallet?.id || wallet?.name || '';
}

function truncateAddress(address) {
  if (!address || address.length < 12) return address || '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getPreferredAccount(accounts = []) {
  const suiMainnetAccount = accounts.find((account) =>
    Array.isArray(account?.chains) ? account.chains.includes(SUI_MAINNET_CHAIN) : false,
  );
  return suiMainnetAccount || accounts[0] || null;
}

function canConnect(wallet) {
  const features = wallet?.features || {};
  return Boolean(
    features['standard:connect'] &&
      (features['sui:signTransaction'] ||
        features['sui:signTransactionBlock'] ||
        features['sui:signAndExecuteTransaction'] ||
        features['sui:signAndExecuteTransactionBlock']),
  );
}

function getConnectableWallets() {
  return walletsApi
    .get()
    .filter(canConnect)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function persistPreferredWallet(wallet) {
  try {
    if (wallet) {
      localStorage.setItem(PREFERRED_WALLET_KEY, getWalletIdentifier(wallet));
    } else {
      localStorage.removeItem(PREFERRED_WALLET_KEY);
    }
  } catch {
    // Ignore storage errors in private browsing or restricted contexts.
  }
}

function getPreferredWalletId() {
  try {
    return localStorage.getItem(PREFERRED_WALLET_KEY);
  } catch {
    return null;
  }
}

function cleanupWalletEvents() {
  if (walletEventsUnsubscribe) {
    walletEventsUnsubscribe();
    walletEventsUnsubscribe = null;
  }
}

function closeWalletPicker() {
  if (pickerEl) {
    pickerEl.hidden = true;
  }
}

function openWalletPicker() {
  if (pickerEl) {
    pickerEl.hidden = false;
  }
}

function toggleWalletPicker() {
  if (!pickerEl) return;
  pickerEl.hidden = !pickerEl.hidden;
}

function getSigner(wallet, account) {
  return async ({ transaction, chain = SUI_MAINNET_CHAIN }) => {
    if (!wallet || !account) {
      throw new Error('Wallet not connected');
    }

    const client = new CoreClient({ url: getSuiRpcUrl() });
    transaction.setSenderIfNotSet(account.address);

    if (wallet.features['sui:signTransaction'] || wallet.features['sui:signTransactionBlock']) {
      const signedTx = await walletStandardSignTransaction(wallet, {
        transaction,
        account,
        chain,
      });

      return client.executeTransactionBlock({
        transactionBlock: signedTx.bytes,
        signature: signedTx.signature,
        options: {
          showEffects: true,
          showObjectChanges: true,
        },
        requestType: 'WaitForLocalExecution',
      });
    }

    if (
      wallet.features['sui:signAndExecuteTransaction'] ||
      wallet.features['sui:signAndExecuteTransactionBlock']
    ) {
      const txResult = await walletStandardSignAndExecuteTransaction(wallet, {
        transaction,
        account,
        chain,
      });

      return client.waitForTransaction({
        digest: txResult.digest,
        options: {
          showEffects: true,
          showObjectChanges: true,
        },
      });
    }

    throw new Error(`Wallet ${wallet.name} does not support transaction signing.`);
  };
}

function syncBridgeState() {
  if (selectedWallet && selectedAccount) {
    updateWalletBridgeState({
      wallet: selectedWallet,
      account: selectedAccount,
      status: 'connected',
      disconnect: disconnectWallet,
      signAndExecute: getSigner(selectedWallet, selectedAccount),
    });
    return;
  }

  updateWalletBridgeState({
    wallet: null,
    account: null,
    status: isConnecting ? 'connecting' : 'disconnected',
    disconnect: null,
    signAndExecute: null,
  });
}

function refreshButtonUi() {
  if (!buttonEl || !disconnectEl) return;

  if (isConnecting) {
    buttonEl.textContent = 'Connecting...';
    buttonEl.disabled = true;
  } else if (selectedAccount) {
    buttonEl.textContent = `🔗 ${truncateAddress(selectedAccount.address)}`;
    buttonEl.disabled = false;
  } else {
    buttonEl.textContent = '🔗 Connect Wallet';
    buttonEl.disabled = false;
  }

  disconnectEl.hidden = !selectedAccount;
}

function renderWalletList() {
  if (!walletListEl) return;

  const wallets = getConnectableWallets();
  walletListEl.innerHTML = '';

  if (wallets.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'wallet-picker-empty';
    emptyState.textContent = 'No Sui wallet detected. Install a wallet extension to continue.';
    walletListEl.appendChild(emptyState);
    return;
  }

  wallets.forEach((wallet) => {
    const walletButton = document.createElement('button');
    walletButton.type = 'button';
    walletButton.className = 'wallet-option';

    const icon = document.createElement('img');
    icon.className = 'wallet-option-icon';
    icon.src = wallet.icon;
    icon.alt = `${wallet.name} icon`;

    const label = document.createElement('span');
    label.className = 'wallet-option-label';
    label.textContent = wallet.name;

    walletButton.append(icon, label);

    if (selectedWallet && getWalletIdentifier(selectedWallet) === getWalletIdentifier(wallet)) {
      walletButton.classList.add('active');
    }

    walletButton.addEventListener('click', async () => {
      await connectToWallet(wallet, true);
    });

    walletListEl.appendChild(walletButton);
  });
}

function subscribeToWalletEvents(wallet) {
  cleanupWalletEvents();

  const eventsFeature = wallet?.features?.['standard:events'];
  if (!eventsFeature?.on) {
    return;
  }

  walletEventsUnsubscribe = eventsFeature.on('change', ({ accounts }) => {
    if (!selectedWallet || getWalletIdentifier(wallet) !== getWalletIdentifier(selectedWallet)) {
      return;
    }

    const nextAccount = getPreferredAccount(accounts ?? wallet.accounts ?? []);
    if (nextAccount) {
      selectedAccount = nextAccount;
      refreshButtonUi();
      renderWalletList();
      syncBridgeState();
      return;
    }

    selectedWallet = null;
    selectedAccount = null;
    persistPreferredWallet(null);
    refreshButtonUi();
    renderWalletList();
    syncBridgeState();
  });
}

async function connectToWallet(wallet, persistSelection = true) {
  if (!wallet || isConnecting) return;

  isConnecting = true;
  refreshButtonUi();
  syncBridgeState();

  try {
    const connectFeature = wallet.features['standard:connect'];
    const connectResult = await connectFeature.connect();
    const account = getPreferredAccount(connectResult?.accounts || wallet.accounts);

    if (!account) {
      throw new Error(`Wallet ${wallet.name} did not return an authorized account.`);
    }

    selectedWallet = wallet;
    selectedAccount = account;

    if (persistSelection) {
      persistPreferredWallet(wallet);
    }

    subscribeToWalletEvents(wallet);
    closeWalletPicker();
  } catch (error) {
    console.error('Wallet connection failed:', error);
  } finally {
    isConnecting = false;
    refreshButtonUi();
    renderWalletList();
    syncBridgeState();
  }
}

async function disconnectWallet() {
  if (!selectedWallet) return;

  try {
    const disconnectFeature = selectedWallet.features['standard:disconnect'];
    if (disconnectFeature?.disconnect) {
      await disconnectFeature.disconnect();
    }
  } catch (error) {
    console.warn('Wallet disconnect failed:', error);
  } finally {
    cleanupWalletEvents();
    selectedWallet = null;
    selectedAccount = null;
    persistPreferredWallet(null);
    closeWalletPicker();
    refreshButtonUi();
    renderWalletList();
    syncBridgeState();
  }
}

function attachGlobalHandlers(container) {
  document.addEventListener('click', (event) => {
    if (!pickerEl || pickerEl.hidden) return;
    if (!container.contains(event.target)) {
      closeWalletPicker();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeWalletPicker();
    }
  });
}

async function attemptAutoReconnect() {
  const preferredWalletId = getPreferredWalletId();
  if (!preferredWalletId || selectedWallet || isConnecting) return;

  const wallet = getConnectableWallets().find(
    (candidate) => getWalletIdentifier(candidate) === preferredWalletId,
  );

  if (!wallet) {
    return;
  }

  await connectToWallet(wallet, false);
}

export function mountWalletConnectButton(target) {
  const container = typeof target === 'string' ? document.getElementById(target) : target;
  if (!container) {
    console.warn('Wallet connect container not found');
    return null;
  }

  if (mountedContainer === container) {
    return { unmount: () => {} };
  }

  mountedContainer = container;
  container.innerHTML = `
    <div class="wallet-connect-button">
      <button type="button" class="nav-btn" data-wallet-connect-trigger="true">🔗 Connect Wallet</button>
      <div class="wallet-picker" hidden>
        <div class="wallet-picker-title">Select Wallet</div>
        <div class="wallet-picker-list"></div>
        <button type="button" class="wallet-disconnect-btn" hidden>Disconnect</button>
      </div>
    </div>
  `;

  buttonEl = container.querySelector('[data-wallet-connect-trigger]');
  pickerEl = container.querySelector('.wallet-picker');
  walletListEl = container.querySelector('.wallet-picker-list');
  disconnectEl = container.querySelector('.wallet-disconnect-btn');

  buttonEl?.addEventListener('click', () => {
    if (selectedAccount) {
      toggleWalletPicker();
      return;
    }
    openWalletPicker();
  });

  disconnectEl?.addEventListener('click', async () => {
    await disconnectWallet();
  });

  walletsApi.on('register', () => {
    renderWalletList();
    void attemptAutoReconnect();
  });

  walletsApi.on('unregister', () => {
    if (
      selectedWallet &&
      !getConnectableWallets().some(
        (wallet) => getWalletIdentifier(wallet) === getWalletIdentifier(selectedWallet),
      )
    ) {
      cleanupWalletEvents();
      selectedWallet = null;
      selectedAccount = null;
      persistPreferredWallet(null);
      syncBridgeState();
    }
    renderWalletList();
    refreshButtonUi();
  });

  attachGlobalHandlers(container);
  renderWalletList();
  refreshButtonUi();
  syncBridgeState();
  void attemptAutoReconnect();

  return {
    unmount() {
      cleanupWalletEvents();
      if (mountedContainer === container) {
        mountedContainer = null;
      }
    },
  };
}
