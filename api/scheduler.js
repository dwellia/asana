// api/scheduler.js
// Runs daily at 12pm UTC via Vercel cron.
// Reads the Maintenance Schedule Config project in Asana,
// pulls checkout dates from Hospitable, and creates tasks
// in the maintenance projects timed to checkout/cleaning days.

import {
  asana, getAllTasks, getOpenTaskMap,
  getCheckoutDates, findNextCheckout,
  PROJECTS, ASSIGNEES, MAINTENANCE_SECTIONS,
  HOSPITABLE_PROPERTIES, frequencyToSection,
  parseTaskNotes, today, addDays, daysBetween,
} from '../lib/utils.js';

export default async function handler(req, res) {
  // Allow manual triggering via GET, Vercel cron sends GET too
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional: secure the endpoint with a secret
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`[scheduler] Starting run — ${today()}`);
  const results = { created: [], skipped: [], errors: [] };

  try {
    // ── Step 1: Load schedule config tasks from Asana ─────────────────────
    console.log('[scheduler] Loading schedule config from Asana...');
    const configTasks = await getAllTasks(
      PROJECTS.schedule_config,
      'gid,name,notes,due_on,completed,assignee'
    );

    // Filter to only incomplete tasks (completed = retired)
    const activeTasks = configTasks.filter(t => !t.completed);
    console.log(`[scheduler] Found ${activeTasks.length} active schedule items`);

    // ── Step 2: Load checkout dates for both properties (next 90 days) ────
    const fromDate = today();
    const toDate   = addDays(fromDate, 90);

    const checkouts = {};
    for (const [propKey, propId] of Object.entries(HOSPITABLE_PROPERTIES)) {
      if (!propId) {
        console.warn(`[scheduler] No Hospitable property ID for ${propKey} — skipping calendar`);
        checkouts[propKey] = [];
        continue;
      }
      console.log(`[scheduler] Fetching checkout dates for ${propKey}...`);
      checkouts[propKey] = await getCheckoutDates(propId, fromDate, toDate);
      console.log(`[scheduler] ${propKey}: ${checkouts[propKey].length} checkouts found in next 90 days`);
    }

    // ── Step 3: Load open tasks per maintenance project (duplicate check) ─
    const openTaskMaps = {};
    for (const [propKey, projectId] of Object.entries({
      delta_dawn:   PROJECTS.delta_dawn,
      legobi_villa: PROJECTS.legobi_villa,
    })) {
      openTaskMaps[propKey] = await getOpenTaskMap(projectId);
    }

    // ── Step 4: Process each schedule item ────────────────────────────────
    for (const task of activeTasks) {
      try {
        const { frequencyDays, property } = parseTaskNotes(task.notes);

        if (!frequencyDays || !property) {
          console.warn(`[scheduler] Skipping "${task.name}" — missing FREQUENCY or PROPERTY in notes`);
          continue;
        }

        if (!PROJECTS[property]) {
          console.warn(`[scheduler] Skipping "${task.name}" — unknown property "${property}"`);
          continue;
        }

        // last_completed is stored as the task's due_on date
        // (Ryan/Amanda mark it done and we update due_on — see webhook handler)
        const lastCompleted = task.due_on;
        if (!lastCompleted) {
          console.warn(`[scheduler] Skipping "${task.name}" — no due_on (last completed) date set`);
          continue;
        }

        // When is this task next due?
        const nextDueWindow = addDays(lastCompleted, frequencyDays);

        // Already have an open task with this name? Skip.
        const openMap = openTaskMaps[property];
        if (openMap.has(task.name.toLowerCase().trim())) {
          results.skipped.push({ task: task.name, property, reason: 'already open' });
          continue;
        }

        // Find the next checkout on or after the due window
        const propCheckouts = checkouts[property] || [];
        const scheduledDate = findNextCheckout(propCheckouts, nextDueWindow, 45)
          || nextDueWindow; // fallback: schedule on due date if no checkout found

        // Only create if it's within the next 60 days (don't schedule too far ahead)
        const daysOut = daysBetween(today(), scheduledDate);
        if (daysOut > 60) {
          results.skipped.push({ task: task.name, property, reason: `not due yet (${daysOut}d out)`, scheduledDate });
          continue;
        }

        // Determine the right section in the maintenance project
        const sectionKey = frequencyToSection(frequencyDays);
        const sectionId  = MAINTENANCE_SECTIONS[property][sectionKey];
        const projectId  = PROJECTS[property];
        const assignee   = ASSIGNEES[property];

        // Create the task
        const created = await asana('POST', '/tasks', {
          name:        task.name,
          notes:       task.notes.split('\n\nFREQUENCY:')[0], // strip metadata from notes
          due_on:      scheduledDate,
          assignee:    assignee.gid,
          projects:    [projectId],
          memberships: [{ project: projectId, section: sectionId }],
        });

        // Add to open map so we don't double-create in same run
        openMap.set(task.name.toLowerCase().trim(), created.data.gid);

        const checkoutNote = scheduledDate !== nextDueWindow
          ? `(matched to checkout day, due window was ${nextDueWindow})`
          : `(no checkout found, using due date)`;

        console.log(`[scheduler] ✅ Created "${task.name}" for ${property} on ${scheduledDate} ${checkoutNote}`);
        results.created.push({ task: task.name, property, scheduledDate, gid: created.data.gid });

      } catch (taskErr) {
        console.error(`[scheduler] ❌ Error processing "${task.name}":`, taskErr.message);
        results.errors.push({ task: task.name, error: taskErr.message });
      }
    }

    console.log(`[scheduler] Done. Created: ${results.created.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`);

    return res.status(200).json({
      success:   true,
      date:      today(),
      summary:   { created: results.created.length, skipped: results.skipped.length, errors: results.errors.length },
      details:   results,
    });

  } catch (err) {
    console.error('[scheduler] Fatal error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
