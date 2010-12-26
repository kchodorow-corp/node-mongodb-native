var QueryCommand = require('./commands/query_command').QueryCommand,
  GetMoreCommand = require('./commands/get_more_command').GetMoreCommand,
  KillCursorCommand = require('./commands/kill_cursor_command').KillCursorCommand,
  Integer = require('./goog/math/integer').Integer,
  Long = require('./goog/math/long').Long;

/**
 * Constructor for a cursor object that handles all the operations on query result
 * using find. This cursor object is unidirectional and cannot traverse backwards.
 * As an alternative, {@link Cursor#toArray} can be used to obtain all the results.
 * Clients should not be creating a cursor directly, but use {@link Collection#find}
 * to acquire a cursor.
 *
 * @param db {Db} The database object to work with
 * @param collection {Colleciton} The collection to query
 * @param selector
 * @param fields
 * @param skip {number}
 * @param limit {number} The number of results to return. -1 has a special meaning and
 *     is used by {@link Db#eval}
 * @param sort {string|Array<Array<string|object> >} Please refer to {@link Cursor#sort}
 * @param hint
 * @param explain
 * @param snapshot
 * @param timeout
 * @param tailable
 * @param batchSize {number} The number of the subset of results to request the database
 *     to return for every request. This should initially be greater than 1 otherwise
 *     the database will automatically close the cursor. The batch size can be set to 1
 *     with {@link Cursor#batchSize} after performing the initial query to the database.
 *
 * @see Cursor#toArray
 * @see Cursor#skip
 * @see Cursor#sort
 * @see Cursor#limit
 * @see Cursor#batchSize
 * @see Collection#find
 * @see Db#eval
 */
var Cursor = exports.Cursor = function(db, collection, selector, fields, skip, limit, sort, hint, explain, snapshot, timeout, batchSize) {
  this.db = db;
  this.collection = collection;
  this.selector = selector;
  this.fields = fields;
  this.skipValue = skip == null ? 0 : skip;
  this.limitValue = limit == null ? 0 : limit;
  this.sortValue = sort;
  this.hint = hint;
  this.explainValue = explain;
  this.snapshot = snapshot;
  this.timeout = timeout;
  this.tailable = tailable;
  this.batchSizeValue = batchSize == null ? 0 : batchSize;

  this.totalNumberOfRecords = 0;
  this.items = [];
  this.cursorId = this.db.bson_serializer.Long.fromInt(0);
  // State variables for the cursor
  this.state = Cursor.INIT;
  // Keep track of the current query run
  this.queryRun = false;
  this.getMoreTimer = false;
  this.collectionName = (this.db.databaseName ? this.db.databaseName + "." : '') + this.collection.collectionName;
};

/**
 * Resets this cursor to its initial state. All settings like the query string,
 * batchSizeValue, skipValue and limits are preserved.
 */
Cursor.prototype.rewind = function() {
	var self = this;

	if (self.state != Cursor.INIT) {
		if (self.state != Cursor.CLOSED) {
  		self.close(function() {});
		}

		self.numberOfReturned = 0;
		self.totalNumberOfRecords = 0;
		self.items = [];
		self.cursorId = Long.fromInt(0);
		self.state = Cursor.INIT;
		self.queryRun = false;
	}
};

/**
 * Returns an array of documents. The caller is responsible for making sure that there
 * is enough memory to store the results. Note that {@link Cursor#rewind} will be
 * called if this cursor has already been used.
 *
 * @param callback {function(Error, Array<Object>)} This will be called after executing
 *     this method successfully. The first paramter will contain the Error object if an
 *     error occured, or null otherwise. The second paramter will contain an array of 
 *     BSON deserialized objects as a result of the query.
 *
 * @see Cursor#rewind
 * @see Cursor#each
 */
Cursor.prototype.toArray = function(callback) {
  var self = this;

  try {
    if(this.tailable) {
      callback(new Error("Tailable cursor cannot be converted to array"), null);
    } else {
      self.rewind();

      self.fetchAllRecords(function(err, items) {
        callback(err, items);
      });
    }
  } catch(err) {
    callback(new Error(err.toString()), null);
  }
};

/**
 * Iterates over all the documents for this cursor. Unlike {@link Cursor#toArray}, the
 * cursor will only hold a maximum of batch size elements at any given time if batch size
 * is specified. Otherwise, the caller is responsible for making sure that the entire
 * result can fit the memory.  Note that {@link Cursor#rewind} will be called if this
 * cursor has already been used.
 *
 * @param callback {function(Error, Object)} This will be called for every document of
 *     the query result. The first paramter will contain the Error object if an error
 *     occured, or null otherwise. While the second paramter will contain the document.
 *
 * @see Cursor#rewind
 * @see Cursor#toArray
 * @see Cursor#batchSize
 */
Cursor.prototype.each = function(callback) {
  var self = this;
  self.rewind();

  var forEach = function(callback) {
    if(this.state != Cursor.CLOSED) {
      //FIX: stack overflow (on deep callback) (cred: https://github.com/limp/node-mongodb-native/commit/27da7e4b2af02035847f262b29837a94bbbf6ce2)
      process.nextTick(function(){
        // Fetch the next object until there is no more objects
        self.nextObject(function(err, item) {
          if(item != null) {
            callback(null, item);
            self.each(callback);
          } else {
            self.state = Cursor.CLOSED;
            callback(err, null);
          }
        });
      });
    }
  };

  forEach(callback);
};

Cursor.prototype.count = function(callback) {
  this.collection.count(this.selector, callback);
};

/**
 * Sets the sort parameter of this cursor to the given value.
 *
 * This method has the following method signatures:
 * (keyOrList, callback)
 * (keyOrList, direction, callback)
 *
 * @param keyOrList {string|Array<Array<string|object> >} This can be a string or an array.
 *     If passed as a string, the string will be the field to sort. If passed an array,
 *     each element will represent a field to be sorted and should be an array that contains
 *     the format [string, direction]. Example of a valid array passed:
 *
 *     <pre><code>
 *     [
 *       ["id", "asc"], //direction using the abbreviated string format
 *       ["name", -1], //direction using the number format
 *       ["age", "descending"], //direction using the string format
 *     ]
 *     </code></pre>
 *
 * @param direction {string|number} This determines how the results are sorted. "asc",
 *     "ascending" or 1 for asceding order while "desc", "desceding or -1 for descending
 *     order. Note that the strings are case insensitive.
 * @param callback {?function(?Error, ?Cursor)} This will be called after executing
 *     this method. The first parameter will contain an error object when the
 *     cursor is already closed while the second parameter will contain a reference
 *     to this object upon successful execution.
 *
 * @return {Cursor} an instance of this object.
 *
 * @see Cursor#formatSortValue
 */
Cursor.prototype.sort = function(keyOrList, direction, callback) {
  callback = callback || function(){};
  if(typeof direction === "function") { callback = direction; direction = null; }
  if(this.tailable) {
    callback(new Error("Tailable cursor doesn't support sorting"), null);
  } else if(this.queryRun == true || this.state == Cursor.CLOSED) {
    callback(new Error("Cursor is closed"), null);
  } else {
    var order = keyOrList;

    if(direction != null) {
      order = [[keyOrList, direction]];
    }
    this.sortValue = order;
    callback(null, this);
  }
  return this;
};

/**
 * Sets the limit parameter of this cursor to the given value.
 *
 * @param limit {Number} The new limit.
 * @param callback {?function(?Error, ?Cursor)} This will be called after executing
 *     this method. The first parameter will contain an error object when the
 *     limit given is not a valid number or when the cursor is already closed while
 *     the second parameter will contain a reference to this object upon successful
 *     execution.
 *
 * @return {Cursor} an instance of this object.
 */
Cursor.prototype.limit = function(limit, callback) {
  callback = callback || function(){};
  if(this.tailable) {
    callback(new Error("Tailable cursor doesn't support limit"), null);
  } else if(this.queryRun == true || this.state == Cursor.CLOSED) {
    callback(new Error("Cursor is closed"), null);
  } else {
    if(limit != null && limit.constructor != Number) {
      callback(new Error("limit requires an integer"), null);
    } else {
      this.limitValue = limit;
      callback(null, this);
    }
  }
  return this;
};

/**
 * Sets the skip parameter of this cursor to the given value.
 *
 * @param skip {Number} The new skip value.
 * @param callback {?function(?Error, ?Cursor)} This will be called after executing
 *     this method. The first parameter will contain an error object when the
 *     skip value given is not a valid number or when the cursor is already closed while
 *     the second parameter will contain a reference to this object upon successful
 *     execution.
 *
 * @return {Cursor} an instance of this object.
 */
Cursor.prototype.skip = function(skip, callback) {
  callback = callback || function(){};
  if(this.tailable) {
    callback(new Error("Tailable cursor doesn't support skip"), null);
  } else if(this.queryRun == true || this.state == Cursor.CLOSED) {
    callback(new Error("Cursor is closed"), null);
  } else {
    if(skip != null && skip.constructor != Number) {
      callback(new Error("skip requires an integer"), null);
    } else {
      this.skipValue = skip;
      callback(null, this);
    }
  }
  return this;
};

/**
 * Sets the batch size parameter of this cursor to the given value.
 *
 * @param batchSize {Number} The new batch size.
 * @param callback {?function(?Error, ?Cursor)} This will be called after executing
 *     this method. The first parameter will contain an error object when the
 *     batchSize given is not a valid number or when the cursor is already closed while
 *     the second parameter will contain a reference to this object upon successful
 *     execution.
 *
 * @return {Cursor} an instance of this object.
 */
Cursor.prototype.batchSize = function(batchSize, callback) {
  callback = callback || function(){};
  if(this.state == Cursor.CLOSED) {
    callback(new Error("Cursor is closed"), null);
  } else if(batchSize != null && batchSize.constructor != Number) {
    callback(new Error("batchSize requires an integer"), null);
  } else {
    this.batchSizeValue = batchSize;
    callback(null, this);
  }

  return this;
};

/**
 * Generates a QueryCommand object using the parameters of this cursor.
 *
 * @return {QueryCommand} The command object
 */
Cursor.prototype.generateQueryCommand = function() {
  // Unpack the options
  var timeout  = this.timeout != null ? this.timeout : QueryCommand.OPTS_NONE;
  var queryOptions = timeout;
	// limitValue of -1 is a special case used by eval
	var numberToReturn = this.limitValue == -1 ? -1 : this.limitRequest();
  var queryOptions = QueryCommand.OPTS_NONE;
  if (this.timeout != null) queryOptions += this.timeout;
  if (this.tailable != null) {
      queryOptions += QueryCommand.OPTS_TAILABLE_CURSOR;
      this.skipValue = this.limitValue = 0;
  }

  var numberToReturn = this.limitValue == -1 ? -1 : this.limitRequest();

  // Check if we need a special selector
  if(this.sortValue != null || this.explainValue != null || this.hint != null || this.snapshot != null) {
    // Build special selector
    var specialSelector = {'query':this.selector};
    if(this.sortValue != null) specialSelector['orderby'] = this.formattedOrderClause();
    if(this.hint != null && this.hint.constructor == Object) specialSelector['$hint'] = this.hint;
    if(this.explainValue != null) specialSelector['$explain'] = true;
    if(this.snapshot != null) specialSelector['$snapshot'] = true;

    return new QueryCommand(this.db, this.collectionName, queryOptions, this.skipValue, numberToReturn, specialSelector, this.fields);
  } else {
    return new QueryCommand(this.db, this.collectionName, queryOptions, this.skipValue, numberToReturn, this.selector, this.fields);
  }
};

Cursor.prototype.formattedOrderClause = function() {
  var orderBy = {};
  var self = this;

  if(this.sortValue instanceof Array) {
    this.sortValue.forEach(function(sortElement) {
      if(sortElement.constructor == String) {
        orderBy[sortElement] = 1;
      } else {
        orderBy[sortElement[0]] = self.formatSortValue(sortElement[1]);
      }
    });
  } else if(Object.prototype.toString.call(this.sortValue) === '[object Object]') {
    throw new Error("Invalid sort argument was supplied");
  } else if(this.sortValue.constructor == String) {
    orderBy[this.sortValue] = 1
  } else {
    throw Error("Illegal sort clause, must be of the form " +
      "[['field1', '(ascending|descending)'], ['field2', '(ascending|descending)']]");
  }
  return orderBy;
};

Cursor.prototype.formatSortValue = function(sortDirection) {
  var value = ("" + sortDirection).toLowerCase();
  if(value == 'ascending' || value == 'asc' || value == 1) return 1;
  if(value == 'descending' || value == 'desc' || value == -1 ) return -1;
  throw Error("Illegal sort clause, must be of the form " +
    "[['field1', '(ascending|descending)'], ['field2', '(ascending|descending)']]");
};

/**
 * @return {number} The number of records to request per batch.
 */
Cursor.prototype.limitRequest = function() {
  var requestedLimit = this.limitValue;

  if (this.limitValue > 0) {
    if (this.batchSizeValue > 0) {
      requestedLimit = this.limitValue < this.batchSizeValue ?
				this.limitValue : this.batchSizeValue;
    }
  }
  else {
    requestedLimit = this.batchSizeValue;
  }

	return requestedLimit;
};

Cursor.prototype.nextObject = function(callback) {
  var self = this;

  if(self.state == Cursor.INIT) {
    try {
      self.db.executeCommand(self.generateQueryCommand(), function(err, result) {
        if(!err && result.documents[0] && result.documents[0]['$err']) {
          self.close(function() {callback(result.documents[0]['$err'], null);});
          return;
        }
        self.queryRun = true;
        self.state = Cursor.OPEN; // Adjust the state of the cursor
        self.cursorId = result.cursorId;
        self.totalNumberOfRecords = result.numberReturned;

        // Add the new documents to the list of items
        self.items = self.items.concat(result.documents);
        self.nextObject(callback);
      });
    } catch(err) {
      callback(new Error(err.toString()), null);
    }
  } else if(self.items.length) {
    callback(null, self.items.shift());
  } else if(self.cursorId.greaterThan(self.db.bson_serializer.Long.fromInt(0))) {
    self.getMore(callback);
  } else {
    self.close(function() {callback(null, null);});
  }
}

Cursor.prototype.getMore = function(callback) {
  var self = this;
  var limit = 0;

  if (!self.tailable && self.limitValue > 0) {
    limit = self.limitValue - self.totalNumberOfRecords;
    if (limit < 1) {
      self.close(function() {callback(null, null);});
      return;
    }
  }
  try {
    var getMoreCommand = new GetMoreCommand(self.db, self.collectionName, limit, self.cursorId);
    // Execute the command
    self.db.executeCommand(getMoreCommand, function(err, result) {

      self.cursorId = result.cursorId;
      self.totalNumberOfRecords += result.numberReturned;
      // Determine if there's more documents to fetch
      if(result.numberReturned > 0) {
        self.items = self.items.concat(result.documents);
        callback(null, self.items.shift());
      } else if(self.tailable) {
        self.getMoreTimer = setTimeout(function() {self.getMore(callback);}, 500);
      } else {
        self.close(function() {callback(null, null);});
      }
    });
  } catch(err) {
    self.close(function() {
      callback(new Error(err.toString()), null);
    });
  }
}

Cursor.prototype.explain = function(callback) {
  var limit = (-1)*Math.abs(this.limitValue);
  // Create a new cursor and fetch the plan
  var cursor = new Cursor(this.db, this.collection, this.selector, this.fields, this.skipValue, limit,
      this.sortValue, this.hint, true, this.snapshot, this.timeout, this.tailable);
  cursor.nextObject(function(err, item) {
    // close the cursor
    cursor.close(function(err, result) {
      callback(null, item);
    });
  });
};

Cursor.prototype.streamRecords = function(options) {
  var args = Array.prototype.slice.call(arguments, 0);
  options = args.length ? args.shift() : {};

  var
    self = this,
    stream = new process.EventEmitter(),
    recordLimitValue = this.limitValue || 0,
    emittedRecordCount = 0,
    queryCommand = this.generateQueryCommand();

  // see http://www.mongodb.org/display/DOCS/Mongo+Wire+Protocol
  queryCommand.numberToReturn = options.fetchSize ? options.fetchSize : 500;

  execute(queryCommand);

  function execute(command) {
    self.db.executeCommand(command, function(err,result) {
      if (!self.queryRun && result) {
        self.queryRun = true;
        self.cursorId = result.cursorId;
        self.state = Cursor.OPEN;
        self.getMoreCommand = new GetMoreCommand(self.db, self.collectionName, queryCommand.numberToReturn, result.cursorId);
      }
      if (result.documents && result.documents.length) {
        try {
          result.documents.forEach(function(doc){
            if (recordLimitValue && emittedRecordCount>=recordLimitValue) {
              throw("done");
            }
            emittedRecordCount++;
            stream.emit('data', doc);
          });
        } catch(err) {
          if (err != "done") { throw err; }
          else {
            stream.emit('end', recordLimitValue);
            self.close(function(){});
            return(null);
          }
        }
        // rinse & repeat
        execute(self.getMoreCommand);
      } else {
        self.close(function(){
          stream.emit('end', recordLimitValue);
        });
      }
    });
  }
  return stream;
};

Cursor.prototype.close = function(callback) {
  var self = this
  this.getMoreTimer && clearTimeout(this.getMoreTimer);
  // Close the cursor if not needed
  if(this.cursorId instanceof self.db.bson_serializer.Long && this.cursorId.greaterThan(self.db.bson_serializer.Long.fromInt(0))) {
    try {
      var command = new KillCursorCommand(this.db, [this.cursorId]);
      this.db.executeCommand(command, function(err, result) {});
    } catch(err) {}
  }

  this.cursorId = self.db.bson_serializer.Long.fromInt(0);
  this.state    = Cursor.CLOSED;
  if (callback) callback(null, this);
};

Cursor.prototype.isClosed = function() {
  return this.state == Cursor.CLOSED ? true : false;
};

// Static variables
Cursor.INIT = 0;
Cursor.OPEN = 1;
Cursor.CLOSED = 2;
