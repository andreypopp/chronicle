(function(root) {

// Import
// ========

var _,
    errors,
    util,
    Chronicle,
    Compound,
    TextOperation,
    ArrayOperation;

if (typeof exports !== 'undefined') {
  _ = require('underscore');
  errors   = require('../util/errors');
  util   = require('../util/util');
  Chronicle = require('../../chronicle');
  Compound = require('./compound');
  TextOperation = require('./text_operation');
  ArrayOperation = require('./array_operation');
} else {
  _ = root._;
  errors = root.Substance.errors;
  util = root.Substance.util;
  Chronicle = root.Substance.Chronicle;
  Compound = Chronicle.OT.Compound;
  TextOperation = Chronicle.OT.TextOperation;
  ArrayOperation = Chronicle.OT.ArrayOperation;
}

var NOP = 0;
var CREATE = 1;
var DELETE = -1;
var UPDATE = 4;

var ObjectOperation = function(data) {

  this.type = data.type;
  this.path = data.path;

  if (this.type === CREATE || this.type === DELETE) {
    this.val = data.val;
  }

  // Updates can be given as value or as Operation (Text, Array)
  else if (this.type === UPDATE) {
    if (data.diff !== undefined) {
      this.diff = data.diff;
      this.propertyType = data.propertyType;
    } else {
      throw new errors.ChronicleError("Illegal argument: update by value or by diff must be provided");
    }
  }

};

ObjectOperation.fromJSON = function(data) {

  if (data.type === Compound.TYPE) {
    var ops = [];
    for (var idx = 0; idx < data.ops.length; idx++) {
      ops.push(ObjectOperation.fromJSON(data.ops[idx]));
    }
    return ObjectOperation.Compound(ops);

  } else {
    return new ObjectOperation(data);
  }
};

function resolve(obj, path, create) {
  if (path.length === 0) return undefined;

  var key, idx;
  for (idx = 0; idx < path.length-1; idx++) {
    key = path[idx];
    if (obj[key] === undefined) {
      if (create) {
        obj[key] = {};
      } else {
        throw new errors.ChronicleError("Can not resolve property for path: " + JSON.stringify(path));
      }
    }
    obj = obj[key];
  }

  key = path[idx];
  return {parent: obj, key: key};
}

ObjectOperation.__prototype__ = function() {

  this.clone = function() {
    return new ObjectOperation(this);
  };

  this.isNOP = function() {
    return this.type === NOP;
  };

  this.apply = function(obj) {
    if (this.type === NOP) return obj;

    var prop = resolve(obj, this.path, this.type === CREATE);

    if (this.type === CREATE) {
      if (prop.parent[prop.key] !== undefined) {
        throw new errors.ChronicleError("Value already exists. key =" + prop.key + ", " + JSON.stringify(prop.parent));
      }

      prop.parent[prop.key] = util.clone(this.val);
    }

    else if (this.type === DELETE) {
      // TODO: maybe we could tolerate such deletes
      if (prop.parent[prop.key] === undefined) {
        throw new errors.ChronicleError("Key " + prop.key + " not found in " + JSON.stringify(prop.parent));
      }

      delete prop.parent[prop.key];
    }

    else if (this.type === UPDATE) {
      // TODO: maybe we could be less hysterical
      if (prop.parent[prop.key] === undefined) {
        throw new errors.ChronicleError("Key " + prop.key + " not found in " + JSON.stringify(prop.parent));
      }

      var val = prop.parent[prop.key];

      if (this.propertyType === 'string') {
        val = TextOperation.apply(this.diff, val);
      } else if (this.propertyType === 'array') {
        val = ArrayOperation.apply(this.diff, val);
      } else {
        throw new errors.ChronicleError("Unsupported type for operational update.");
      }
      prop.parent[prop.key] = val;

    }

    else {
      throw new errors.ChronicleError("Illegal state.");
    }

    return obj;
  };

  this.invert = function() {

    if (this.type === NOP) {
      return { type: NOP };
    }

    var result = new ObjectOperation(this);

    if (this.type === CREATE) {
      result.type = DELETE;
    }
    else if (this.type === DELETE) {
      result.type = CREATE;
    }
    else if (this.type === UPDATE) {
      var invertedDiff;
      if (this.propertyType === 'string') {
        invertedDiff = TextOperation.fromJSON(this.diff).invert();
      } else if (this.propertyType === 'array') {
        invertedDiff = ArrayOperation.fromJSON(this.diff).invert();
      }
      result.diff = invertedDiff;
      result.propertyType = this.propertyType;
    }

    else {
      throw new errors.ChronicleError("Illegal state.");
    }

    return result;
  };

  this.hasConflict = function(other) {
    return ObjectOperation.hasConflict(this, other);
  };

  this.toJSON = function() {

    if (this.type === NOP) {
      return {
        type: NOP
      };
    }

    var data = {
      type: this.type,
      path: this.path,
    };

    if (this.type === CREATE || this.type === DELETE) {
      data.val = this.val;
    } else if (this.type === UPDATE) {
      data.diff = this.diff;
      data.propertyType = this.propertyType;
    }

    return data;
  };

};
ObjectOperation.prototype = new ObjectOperation.__prototype__();


var hasConflict = function(a, b) {
  if (a.type === NOP || b.type === NOP) return false;

  return _.isEqual(a.path, b.path);
};

var transform_delete_delete = function(a, b) {
  // both operations have the same effect.
  // the transformed operations are turned into NOPs
  a.type = NOP;
  b.type = NOP;
};

var transform_create_create = function() {
  // TODO: maybe it would be possible to create an differntial update that transforms the one into the other
  // However, we fail for now.
  throw new errors.ChronicleError("Can not transform two concurring creates of the same property");
};

var transform_delete_create = function(a, b, flipped) {
  if (a.type !== DELETE) {
    return transform_delete_create(b, a, true);
  }

  if (!flipped) {
    a.type = NOP;
  } else {
    a.val = b.val;
    b.type = NOP;
  }
};

var transform_delete_update = function(a, b, flipped) {
  if (a.type !== DELETE) {
    return transform_delete_update(b, a, true);
  }

  var op;
  if (b.propertyType === 'string') {
    op = TextOperation.fromJSON(b.diff);
  } else if (b.propertyType === 'array') {
    op = ArrayOperation.fromJSON(b.diff);
  }

  // (DELETE, UPDATE) is transformed into (DELETE, CREATE)
  if (!flipped) {
    a.type = NOP;
    b.type = CREATE;
    b.val = op.apply(a.val);
  }
  // (UPDATE, DELETE): the delete is updated to delete the updated value
  else {
    a.val = op.apply(a.val);
    b.type = NOP;
  }

};

var transform_create_update = function() {
  // it is not possible to reasonably transform this.
  throw new errors.ChronicleError("Can not transform a concurring create and update of the same property");
};

var transform_update_update = function(a, b) {

  // Note: this is a conflict the user should know about

  var op_a, op_b, t;
  if (b.propertyType === 'string') {
    op_a = TextOperation.fromJSON(a.diff);
    op_b = TextOperation.fromJSON(b.diff);
    t = TextOperation.transform(op_a, op_b, {inplace: true});
  } else if (b.propertyType === 'array') {
    op_a = ArrayOperation.fromJSON(a.diff);
    op_b = ArrayOperation.fromJSON(b.diff);
    t = ArrayOperation.transform(op_a, op_b, {inplace: true});
  }

  a.diff = t[0];
  b.diff = t[1];
};

var __transform__ = [];
__transform__[DELETE+DELETE] = transform_delete_delete;
__transform__[DELETE+CREATE] = transform_delete_create;
__transform__[DELETE+UPDATE] = transform_delete_update;
__transform__[CREATE+CREATE] = transform_create_create;
__transform__[CREATE+UPDATE] = transform_create_update;
__transform__[UPDATE+UPDATE] = transform_update_update;

var transform = function(a, b, options) {

  options = options || {};

  var conflict = hasConflict(a, b);

  if (options.check && conflict) {
    throw Chronicle.mergeConflict(a, b);
  }

  if (!options.inplace) {
    a = util.clone(a);
    b = util.clone(b);
  }

  // without conflict: a' = a, b' = b
  if (!conflict) {
    return [a, b];
  }

  __transform__[a.type + b.type](a,b);

  return [a, b];
};

ObjectOperation.transform = Compound.createTransform(transform);
ObjectOperation.hasConflict = hasConflict;

var __apply__ = function(op, obj) {
  if (!(op instanceof ObjectOperation)) {
    op = ObjectOperation.fromJSON(op);
  }
  return op.apply(obj);
};

// TODO: rename to "exec" or perform
ObjectOperation.apply = __apply__;

ObjectOperation.Create = function(path, val) {
  return new ObjectOperation({type: CREATE, path: path, val: val});
};

ObjectOperation.Delete = function(path, val) {
  return new ObjectOperation({type: DELETE, path: path, val: val});
};

function getPropertyType(op) {

  if (op instanceof Compound) {
    return getPropertyType(op.ops[0]);
  }

  if (op instanceof TextOperation) {
    return "string";
  }

  else if (op instanceof ArrayOperation) {
    return  "array";
  }

  else {
    throw new errors.ChronicleError("Unsupported type for incremental updates");
  }

}

ObjectOperation.Update = function(path, diff) {

  var propertyType = getPropertyType(diff);
  return new ObjectOperation({
    type: UPDATE,
    path: path,
    diff: diff,
    propertyType: propertyType
  });
};

ObjectOperation.Compound = function(ops) {
  return new Compound(ops);
};

// Export
// ========

if (typeof exports !== 'undefined') {
  module.exports = ObjectOperation;
} else {
  Chronicle.OT = Chronicle.OT || {};
  Chronicle.OT.ObjectOperation = ObjectOperation;
}

})(this);


/* NOTE: snippets I used at the beginning, which could be handy when implementing
 convenience helpers

// Removes everything from a given object which is defined
// in oldData but not in newData
function remove(obj, data) {
  var keys = Object.getOwnPropertyNames(data);

  for (var idx = 0; idx < keys.length; idx++) {
    var key = keys[idx];
    if (_.isObject(data[key])) {
      if (!_.isObject(obj[key])) {
        throw new ChronicleError("Illegal target object: expected an object with key " + key);
      }
      remove(obj[key], data[key]);
    } else {
      delete obj[key];
    }
  }

  return result;
}

function update(obj, data) {
  var keys = Object.getOwnPropertyNames(data);

  for (var idx = 0; idx < keys.length; idx++) {
    var key = keys[idx];

    if (_.isObject(data[key])) {
      if (!_.isObject(obj[key])) {
        obj[key] = data[key];
      } else {
        update(obj[key], data[key]);
      }
    } else {
      obj[key] = data[key];
    }
  }
}

function intersects = function(a, b) {
  var keys = Object.getOwnPropertyNames(b);

  for (var idx = 0; idx < keys.length; idx++) {
    var key = keys[idx];

    if (b[key] !== undefined) {
      if (_.isObject(a[key]) && _.isObject(b[key])) {
        if(intersects(a[key], b[key])) {
          return true;
        }
      } else {
        return true;
      }
    }
  }

  return false;
}

*/