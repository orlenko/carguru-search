import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';

export const statsCommand = new Command('stats')
  .description('Show statistics about your search')
  .action(async () => {
    try {
      const db = getDatabase();
      const stats = db.getStats();

      console.log('\n📊 Search Statistics\n');

      console.log(`Total Listings: ${stats.total}`);

      if (Object.keys(stats.byStatus).length > 0) {
        console.log('\nBy Status:');
        const statusOrder = ['new', 'contacted', 'carfax_requested', 'carfax_received', 'analyzed', 'shortlisted', 'rejected'];
        for (const status of statusOrder) {
          if (stats.byStatus[status]) {
            console.log(`  ${status.padEnd(20)} ${stats.byStatus[status]}`);
          }
        }
      }

      if (Object.keys(stats.bySource).length > 0) {
        console.log('\nBy Source:');
        for (const [source, count] of Object.entries(stats.bySource)) {
          console.log(`  ${source.padEnd(20)} ${count}`);
        }
      }

      console.log('');
    } catch (error) {
      console.error('Error getting stats:', error);
      process.exit(1);
    }
  });
