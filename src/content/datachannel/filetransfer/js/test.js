'use strict';
// This is a basic test file for use with testling.
// The test script language comes from tape.
/* jshint node: true */
var test = require('tape');

var webdriver = require('selenium-webdriver');
var seleniumHelpers = require('../../../../../test/selenium-lib');

test('Filetransfer via Datachannels', function(t) {
  var driver = seleniumHelpers.buildDriver();

  driver.get('file://' + process.cwd() +
      '/src/content/datachannel/filetransfer/index.html')
  .then(function() {
    t.pass('page loaded');
    // Based on https://saucelabs.com/resources/articles/selenium-file-upload
    return driver.findElement(webdriver.By.id('fileInput'))
       .sendKeys(process.cwd() + '/index.html');
  })
  .then(function() {
    // Wait for the received element to be displayed.
    return driver.wait(function() {
      return driver.findElement(webdriver.By.id('received')).isDisplayed();
    }, 30 * 1000);
  })
  .then(function() {
    t.end();
  })
  .then(null, function(err) {
    t.fail(err);
    t.end();
  });
});