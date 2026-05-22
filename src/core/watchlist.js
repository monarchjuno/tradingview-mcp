/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureWatchlistOpen({ evaluate: evalFn = evaluate } = {}) {
  const panelState = await evalFn(`
    (function() {
      var rightArea = document.querySelector('[class*="layout__area--right"]');
      var watchlist = document.querySelector('[class*="widgetbar-widget-watchlist"]')
        || document.querySelector('[data-name="symbol-list-wrap"]');
      var isOpen = !!(rightArea && rightArea.offsetWidth > 50 && watchlist);
      if (isOpen) return { opened: false, already_open: true };

      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[data-name="base"][aria-label*="Watchlist"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      btn.click();
      return { opened: true };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await sleep(500);
  return panelState;
}

export async function get() {
  // Try internal API first — reads from the active watchlist widget
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

export async function add({ symbol }) {
  // Use keyboard shortcut to open symbol search in watchlist, type symbol, press Enter
  const c = await getClient();

  await ensureWatchlistOpen();

  // Click the "Add symbol" button (various selectors)
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await sleep(300);

  // Type the symbol into the search input
  await c.Input.insertText({ text: symbol });
  await sleep(500);

  // Press Enter to select the first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await sleep(300);

  // Press Escape to close search
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}

export async function remove({ symbol, _deps = {} }) {
  if (!symbol || !String(symbol).trim()) throw new Error('symbol is required');

  const evalAsync = _deps.evaluateAsync || evaluateAsync;
  await ensureWatchlistOpen(_deps);

  const result = await evalAsync(`
    new Promise(function(resolve) {
      var target = ${safeString(String(symbol).trim())};
      var targetNorm = target.toUpperCase();

      function normalize(value) {
        return String(value || '').trim().toUpperCase();
      }

      function rowSymbol(row) {
        return row.getAttribute('data-symbol-full') || row.getAttribute('data-symbol-short') || '';
      }

      function findTargetRow() {
        var container = document.querySelector('[class*="layout__area--right"]') || document;
        var rows = Array.prototype.slice.call(container.querySelectorAll('[data-symbol-full]'));
        var fullMatches = rows.filter(function(row) {
          return normalize(row.getAttribute('data-symbol-full')) === targetNorm;
        });
        if (fullMatches.length > 0) return { rows: fullMatches, match_type: 'full' };

        var shortMatches = rows.filter(function(row) {
          return normalize(row.getAttribute('data-symbol-short')) === targetNorm;
        });
        return { rows: shortMatches, match_type: 'short' };
      }

      function visibleRect(el) {
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }

      try {
        var found = findTargetRow();
        if (!found.rows.length) {
          resolve({ success: false, error: 'Symbol not found in watchlist: ' + target });
          return;
        }

        if (found.rows.length > 1) {
          resolve({
            success: false,
            error: 'Symbol is ambiguous in watchlist: ' + target + '. Use the full exchange-qualified symbol.',
            matches: found.rows.map(rowSymbol),
          });
          return;
        }

        var row = found.rows[0];
        var fullSymbol = row.getAttribute('data-symbol-full') || target;
        row.scrollIntoView({ block: 'center', inline: 'nearest' });
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
        row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
        row.click();

        setTimeout(function() {
          try {
            var removeButton = row.querySelector('[class*="removeButton"]');
            if (!removeButton) {
              resolve({ success: false, error: 'Remove button not found for symbol: ' + fullSymbol });
              return;
            }

            var beforeCount = document.querySelectorAll('[data-symbol-full]').length;
            var rect = visibleRect(removeButton);
            removeButton.click();

            setTimeout(function() {
              var stillPresent = Array.prototype.slice.call(document.querySelectorAll('[data-symbol-full]')).some(function(candidate) {
                return candidate === row || normalize(candidate.getAttribute('data-symbol-full')) === normalize(fullSymbol);
              });
              var afterCount = document.querySelectorAll('[data-symbol-full]').length;
              resolve({
                success: !stillPresent,
                symbol: fullSymbol,
                requested_symbol: target,
                action: stillPresent ? 'remove_attempted' : 'removed',
                match_type: found.match_type,
                before_count: beforeCount,
                after_count: afterCount,
                remove_button_visible: !!rect,
                source: 'dom_remove_button',
                error: stillPresent ? 'Symbol still present after remove click: ' + fullSymbol : undefined,
              });
            }, 400);
          } catch (e) {
            resolve({ success: false, error: e.message || String(e) });
          }
        }, 150);
      } catch (e) {
        resolve({ success: false, error: e.message || String(e) });
      }
    })
  `);

  if (!result?.success) throw new Error(result?.error || 'Failed to remove watchlist symbol');
  return result;
}
